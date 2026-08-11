import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV引号没有闭合");
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows
    .filter((values) => values.some((value) => value !== ""))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(headers, rows) {
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csvCell(row[header])).join(","))
    .join("\n")}\n`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value, pretty = true) {
  return `${JSON.stringify(stableValue(value), null, pretty ? 2 : 0)}\n`;
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function pointerTokens(pointer) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("path_not_found");
  return pointer.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function parentAt(document, tokens) {
  if (tokens.length === 0) throw new Error("root_operation_not_supported");
  let current = document;
  for (const token of tokens.slice(0, -1)) {
    if (current === null || typeof current !== "object" || !(token in current)) {
      throw new Error("path_not_found");
    }
    current = current[token];
  }
  return { parent: current, key: tokens.at(-1) };
}

function applyPatch(source, operations, supportedOperations) {
  let document = structuredClone(source);
  for (const operation of operations) {
    if (!supportedOperations.has(operation.op)) throw new Error("unsupported_patch_op");
    const tokens = pointerTokens(operation.path);
    if (tokens.length === 0) {
      if (operation.op === "test") {
        if (!sameValue(document, operation.value)) throw new Error("test_failed");
      } else {
        document = structuredClone(operation.value);
      }
      continue;
    }
    const { parent, key } = parentAt(document, tokens);
    if (parent === null || typeof parent !== "object") throw new Error("path_not_found");
    if (operation.op === "test") {
      if (!(key in parent) || !sameValue(parent[key], operation.value)) throw new Error("test_failed");
    } else if (operation.op === "replace") {
      if (!(key in parent)) throw new Error("path_not_found");
      parent[key] = structuredClone(operation.value);
    } else if (operation.op === "add") {
      if (Array.isArray(parent)) {
        if (key === "-") parent.push(structuredClone(operation.value));
        else {
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error("path_not_found");
          parent.splice(index, 0, structuredClone(operation.value));
        }
      } else {
        parent[key] = structuredClone(operation.value);
      }
    }
  }
  return document;
}

function loadQueue(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const changes = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      changes.push(JSON.parse(line));
    } catch {
      throw new Error(`patch_queue.jsonl第${index + 1}行无法解析`);
    }
  }
  return changes;
}

function rejection(change, tenantId, reason) {
  return {
    change_id: change.change_id ?? "",
    tenant_id: tenantId ?? "",
    flag_key: change.flag_key ?? "",
    decision: "rejected",
    reason,
    resulting_ramp: "",
    config_path: "",
  };
}

export function compileRelease(inputRoot, outputRoot) {
  const baseFlags = JSON.parse(fs.readFileSync(path.join(inputRoot, "configs", "base_flags.json"), "utf8"));
  const contract = JSON.parse(fs.readFileSync(path.join(inputRoot, "policy", "release_contract.json"), "utf8"));
  const changes = loadQueue(path.join(inputRoot, "changes", "patch_queue.jsonl"));
  const tenants = new Map(
    parseCsv(fs.readFileSync(path.join(inputRoot, "policy", "tenant_policy.csv"), "utf8"))
      .map((row) => [row.tenant_id, { ...row, max_ramp: Number(row.max_ramp) }]),
  );
  const approvals = new Map(
    parseCsv(fs.readFileSync(path.join(inputRoot, "policy", "approvals.csv"), "utf8"))
      .map((row) => [row.change_id, row]),
  );
  const supportedOperations = new Set(contract.supported_patch_ops);
  const allowedReasons = new Set(contract.reason_codes);
  const state = new Map();
  const decisions = [];

  for (const change of changes) {
    if (!Array.isArray(change.target_tenants)) throw new Error(`${change.change_id}缺少target_tenants`);
    for (const tenantId of change.target_tenants) {
      const context = {
        baseFlag: baseFlags[change.flag_key],
        approval: approvals.get(change.change_id),
        tenant: tenants.get(tenantId),
        minimumVersion: null,
        tenantVersion: null,
        patched: null,
        patchError: null,
      };
      let rejectedReason = null;
      for (const gate of contract.decision_order) {
        if (!allowedReasons.has(gate)) throw new Error(`release_contract包含未知原因代码${gate}`);
        if (gate === "unknown_flag" && !context.baseFlag) rejectedReason = gate;
        else if (gate === "missing_approval" && (!context.approval || context.approval.state !== "approved")) {
          rejectedReason = gate;
        } else if (gate === "invalid_semver") {
          context.minimumVersion = parseSemver(change.min_app_version);
          if (!context.minimumVersion) rejectedReason = gate;
        } else if (gate === "unknown_tenant" && !context.tenant) rejectedReason = gate;
        else if (gate === "min_app_version_not_met") {
          context.tenantVersion = parseSemver(context.tenant?.app_version);
          if (!context.tenantVersion || compareSemver(context.tenantVersion, context.minimumVersion) < 0) {
            rejectedReason = gate;
          }
        } else if (gate === "test_failed") {
          const tenantState = state.get(tenantId) ?? new Map();
          const currentConfig = tenantState.has(change.flag_key)
            ? tenantState.get(change.flag_key)
            : context.baseFlag.config;
          try {
            context.patched = applyPatch(currentConfig, change.patch ?? [], supportedOperations);
          } catch (error) {
            context.patchError = error.message;
            if (error.message === "test_failed") rejectedReason = gate;
          }
        } else if (gate === "patch_invalid" && context.patchError && context.patchError !== "test_failed") {
          rejectedReason = gate;
        } else if (gate === "tenant_ramp_limit") {
          if (typeof context.patched?.ramp === "number" && context.patched.ramp > context.tenant.max_ramp) {
            rejectedReason = gate;
          }
        }
        if (rejectedReason) break;
      }

      if (rejectedReason) {
        decisions.push(rejection(change, tenantId, rejectedReason));
        continue;
      }
      if (context.patched === null) throw new Error(`${change.change_id}没有完成补丁处理`);
      const tenantState = state.get(tenantId) ?? new Map();
      tenantState.set(change.flag_key, stableValue(context.patched));
      state.set(tenantId, tenantState);
      decisions.push({
        change_id: change.change_id,
        tenant_id: tenantId,
        flag_key: change.flag_key,
        decision: "applied",
        reason: "",
        resulting_ramp: context.patched.ramp ?? "",
        config_path: `output/configs/${tenantId}/${change.flag_key}.json`,
      });
    }
  }

  const matrix = [];
  for (const tenantId of [...state.keys()].sort()) {
    const tenantState = state.get(tenantId);
    for (const flagKey of [...tenantState.keys()].sort()) {
      const config = stableValue(tenantState.get(flagKey));
      matrix.push({
        tenant_id: tenantId,
        flag_key: flagKey,
        owner: baseFlags[flagKey].owner,
        version: baseFlags[flagKey].current_version,
        enabled: String(Boolean(config.enabled)),
        ramp: config.ramp ?? "",
        config_path: `output/configs/${tenantId}/${flagKey}.json`,
      });
    }
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(outputRoot, "reports"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "configs"), { recursive: true });
  for (const row of matrix) {
    const relative = row.config_path.replace(/^output\//, "");
    const target = path.join(outputRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, stableJson(state.get(row.tenant_id).get(row.flag_key)));
  }

  const reports = path.join(outputRoot, "reports");
  fs.writeFileSync(
    path.join(reports, "release_decisions.csv"),
    csvText(
      ["change_id", "tenant_id", "flag_key", "decision", "reason", "resulting_ramp", "config_path"],
      decisions,
    ),
  );
  fs.writeFileSync(
    path.join(reports, "tenant_release_matrix.csv"),
    csvText(["tenant_id", "flag_key", "owner", "version", "enabled", "ramp", "config_path"], matrix),
  );

  const rejectedByReason = Object.fromEntries(contract.reason_codes.map((reason) => [reason, 0]));
  for (const row of decisions) {
    if (row.decision === "rejected") rejectedByReason[row.reason] += 1;
  }
  const appliedCount = decisions.filter((row) => row.decision === "applied").length;
  const summary = {
    batch_id: contract.batch_id,
    generated_at_utc: contract.generated_at_utc,
    decision_counts: {
      applied: appliedCount,
      rejected: decisions.length - appliedCount,
      total: decisions.length,
    },
    rejected_by_reason: rejectedByReason,
    released_tenants: [...state.keys()].sort(),
    config_files: matrix.map((row) => row.config_path),
    sources: [
      "configs/base_flags.json",
      "changes/patch_queue.jsonl",
      "policy/tenant_policy.csv",
      "policy/approvals.csv",
      "policy/release_contract.json",
    ],
  };
  fs.writeFileSync(path.join(reports, "release_summary.json"), stableJson(summary));
  return { decisions, matrix, summary };
}

const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (modulePath === invokedPath) {
  try {
    const inputRoot = path.resolve(process.argv[2] ?? ".");
    const outputRoot = path.resolve(process.argv[3] ?? "output");
    const result = compileRelease(inputRoot, outputRoot);
    process.stdout.write(`${JSON.stringify(result.summary.decision_counts)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
