import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing argument ${name}`);
  return path.resolve(process.argv[index + 1]);
}

const repositoryRoot = argumentValue('--repository-root');
const evidenceRoot = argumentValue('--evidence-root');
const artifactsRoot = path.join(repositoryRoot, 'artifacts');
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'manifest.json'), 'utf8'));
const inputZip = path.join(artifactsRoot, '输入数据包.zip');
const referenceZip = path.join(artifactsRoot, 'reference.zip');
const answerBook = path.join(artifactsRoot, '关键标准答案.xlsx');
const specificationBook = path.join(artifactsRoot, '任务规格转化.xlsx');
const candidateSource = path.join(repositoryRoot, 'candidate', 'compile_release.mjs');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ale-node-release-'));
const referenceRoot = path.join(sandbox, '参考 输出');
fs.mkdirSync(evidenceRoot, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
  });
  return {
    status: result.status ?? (result.error ? 127 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function writeEvidence(name, value) {
  fs.writeFileSync(path.join(evidenceRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function logRun(name, results) {
  const text = results.map((entry, index) => [
    `run=${index + 1}`,
    `exit_code=${entry.status}`,
    entry.stdout,
    entry.stderr,
  ].join('\n')).join('\n');
  fs.writeFileSync(path.join(evidenceRoot, name), `${text}\n`, 'utf8');
}

function extract(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const command = 'Expand-Archive -LiteralPath $env:ALE_ZIP_SOURCE -DestinationPath $env:ALE_ZIP_DESTINATION -Force';
  const result = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, ALE_ZIP_SOURCE: zip, ALE_ZIP_DESTINATION: destination },
  });
  if (result.status !== 0) throw new Error(`Archive extraction failed for ${path.basename(zip)}\n${result.stderr}`);
}

function fileHashes(root, relative = '', excludeOutput = false) {
  const output = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (excludeOutput && (next === 'output' || next.startsWith(`output${path.sep}`))) continue;
    if (entry.isDirectory()) Object.assign(output, fileHashes(root, next, excludeOutput));
    else output[next.split(path.sep).join('/')] = sha256(path.join(root, next));
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

const expectedPaths = [
  'src/compile_release.mjs',
  'reports/release_decisions.csv',
  'reports/tenant_release_matrix.csv',
  'reports/release_summary.json',
  'configs/alpha/checkout_v2.json',
  'configs/alpha/notify_center.json',
  'configs/gamma/notify_center.json',
  'configs/gamma/search_boost.json',
];

function compareOutputs(actualRoot, expectedRoot) {
  for (const relative of expectedPaths) {
    const actual = path.join(actualRoot, relative);
    const expected = path.join(expectedRoot, relative);
    if (!fs.existsSync(actual)) throw new Error(`Missing output ${relative}`);
    if (relative.endsWith('.csv')) {
      if (JSON.stringify(parseCsv(fs.readFileSync(actual, 'utf8')))
        !== JSON.stringify(parseCsv(fs.readFileSync(expected, 'utf8')))) {
        throw new Error(`CSV semantics differ for ${relative}`);
      }
    } else if (relative.endsWith('.json')) {
      const actualJson = stable(JSON.parse(fs.readFileSync(actual, 'utf8')));
      const expectedJson = stable(JSON.parse(fs.readFileSync(expected, 'utf8')));
      if (JSON.stringify(actualJson) !== JSON.stringify(expectedJson)) throw new Error(`JSON semantics differ for ${relative}`);
    } else if (sha256(actual) !== sha256(expected)) {
      throw new Error(`Fixed output differs for ${relative}`);
    }
  }
}

function prepareRun(name) {
  const root = path.join(sandbox, name);
  extract(inputZip, root);
  const inputRoot = path.join(root, 'input_data');
  const sourceTarget = path.join(inputRoot, 'output', 'src', 'compile_release.mjs');
  fs.mkdirSync(path.dirname(sourceTarget), { recursive: true });
  fs.copyFileSync(candidateSource, sourceTarget);
  return { root, inputRoot };
}

function executeRelease(inputRoot) {
  const command = process.env.ComSpec ?? 'cmd.exe';
  return run(command, ['/d', '/s', '/c', 'npm.cmd', 'run', 'release'], { cwd: inputRoot });
}

function assertRuntimePrerequisites() {
  if (process.platform !== 'win32') throw new Error(`Expected win32, received ${process.platform}`);
  if (Number(process.versions.node.split('.')[0]) !== manifest.node_major) {
    throw new Error(`Expected Node.js ${manifest.node_major}, received ${process.version}`);
  }
  for (const file of [inputZip, referenceZip, answerBook, specificationBook, candidateSource]) {
    if (!fs.existsSync(file)) throw new Error(`Missing repository input ${file}`);
  }
  const packageRoot = path.join(sandbox, '依赖 检查');
  extract(inputZip, packageRoot);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'input_data', 'package.json'), 'utf8'));
  if (Object.keys(packageJson.dependencies ?? {}).length > 0 || Object.keys(packageJson.devDependencies ?? {}).length > 0) {
    throw new Error('Input package contains unexpected dependencies');
  }
}

async function main() {
  assertRuntimePrerequisites();
  extract(referenceZip, referenceRoot);
  const expectedRoot = path.join(referenceRoot, 'output');
  if (sha256(candidateSource) !== sha256(path.join(expectedRoot, 'src', 'compile_release.mjs'))) {
    throw new Error('Candidate source does not match the final reference source');
  }

  const artifacts = Object.fromEntries([
    ['输入数据包.zip', inputZip],
    ['reference.zip', referenceZip],
    ['关键标准答案.xlsx', answerBook],
    ['任务规格转化.xlsx', specificationBook],
  ].map(([name, file]) => [name, sha256(file)]));
  for (const [name, hash] of Object.entries(artifacts)) {
    if (hash !== manifest.attachments[name]) throw new Error(`Manifest hash differs for ${name}`);
  }

  const cleanRoomRuns = [];
  for (const [name, logName] of [['租户 发布甲', 'clean-a.log'], ['租户 发布乙', 'clean-b.log']]) {
    const prepared = prepareRun(name);
    const before = fileHashes(prepared.inputRoot, '', true);
    const first = executeRelease(prepared.inputRoot);
    if (first.status !== 0) throw new Error(`${name} first run failed\n${first.stderr}`);
    compareOutputs(path.join(prepared.inputRoot, 'output'), expectedRoot);
    const firstOutputHashes = fileHashes(path.join(prepared.inputRoot, 'output'));
    const second = executeRelease(prepared.inputRoot);
    if (second.status !== 0) throw new Error(`${name} second run failed\n${second.stderr}`);
    compareOutputs(path.join(prepared.inputRoot, 'output'), expectedRoot);
    const secondOutputHashes = fileHashes(path.join(prepared.inputRoot, 'output'));
    const after = fileHashes(prepared.inputRoot, '', true);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${name} changed source inputs`);
    if (JSON.stringify(firstOutputHashes) !== JSON.stringify(secondOutputHashes)) throw new Error(`${name} output hashes drifted`);
    logRun(logName, [first, second]);
    cleanRoomRuns.push({
      directory: name,
      output_started_empty: true,
      process_runs: 2,
      exit_codes: [first.status, second.status],
      input_unchanged: true,
      reference_match: true,
      generated_paths: expectedPaths.map((item) => `output/${item}`),
    });
  }

  const mutation = prepareRun('规则 变化');
  const mutationPolicy = path.join(mutation.inputRoot, 'policy', 'tenant_policy.csv');
  const changedPolicy = fs.readFileSync(mutationPolicy, 'utf8').replace('delta,trial,4.8.0,5', 'delta,trial,4.8.0,10');
  fs.writeFileSync(mutationPolicy, changedPolicy, 'utf8');
  const mutationResult = executeRelease(mutation.inputRoot);
  if (mutationResult.status !== 0) throw new Error(`Mutation run failed\n${mutationResult.stderr}`);
  const mutationRows = parseCsv(fs.readFileSync(path.join(mutation.inputRoot, 'output', 'reports', 'release_decisions.csv'), 'utf8'));
  const headers = mutationRows[0];
  const decisions = mutationRows.slice(1).map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index]])));
  const deltaDecision = decisions.find((row) => row.change_id === 'CHG-003' && row.tenant_id === 'delta');
  const deltaConfig = path.join(mutation.inputRoot, 'output', 'configs', 'delta', 'notify_center.json');
  if (deltaDecision?.decision !== 'applied' || deltaDecision.resulting_ramp !== '8' || !fs.existsSync(deltaConfig)) {
    throw new Error('Ramp-limit mutation did not produce the required business change');
  }
  logRun('positive-mutation.log', [mutationResult]);

  const negative = prepareRun('队列 损坏');
  const negativeQueue = path.join(negative.inputRoot, 'changes', 'patch_queue.jsonl');
  fs.appendFileSync(negativeQueue, '{invalid_json\n', 'utf8');
  const negativeResult = executeRelease(negative.inputRoot);
  const negativeOutput = path.join(negative.inputRoot, 'output');
  const staleReports = fs.existsSync(path.join(negativeOutput, 'reports'));
  const staleConfigs = fs.existsSync(path.join(negativeOutput, 'configs'));
  if (negativeResult.status === 0 || staleReports || staleConfigs) throw new Error('Invalid queue did not fail closed');
  logRun('negative-invalid-queue.log', [negativeResult]);

  const crlf = prepareRun('换行 边界');
  for (const relative of ['policy/tenant_policy.csv', 'policy/approvals.csv']) {
    const file = path.join(crlf.inputRoot, relative);
    const normalized = fs.readFileSync(file, 'utf8').replace(/\r?\n/gu, '\n').replace(/\n$/u, '');
    fs.writeFileSync(file, `${normalized.replaceAll('\n', '\r\n')}\r\n`, 'utf8');
  }
  const crlfResult = executeRelease(crlf.inputRoot);
  if (crlfResult.status !== 0) throw new Error(`CRLF run failed\n${crlfResult.stderr}`);
  compareOutputs(path.join(crlf.inputRoot, 'output'), expectedRoot);
  logRun('crlf-inputs.log', [crlfResult]);

  const evidence = {
    schema_version: 1,
    result: 'PASS',
    task_asset_id: manifest.task_asset_id,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    commit_sha: process.env.GITHUB_SHA ?? '',
    workflow_run_id: Number(process.env.GITHUB_RUN_ID ?? 0),
    workflow_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
    runner_image: 'windows-2025',
    runner_os: process.env.RUNNER_OS ?? '',
    platform: process.platform,
    os_release: os.release(),
    node_version: process.version,
    primary_software_executed: true,
    attachment_hashes: artifacts,
    attachment_hashes_match: true,
    clean_directory_count: cleanRoomRuns.length,
    process_runs_per_directory: 2,
    clean_room_runs: cleanRoomRuns,
    inputs_unchanged: true,
    reference_match: true,
    structured_semantics_compared: true,
    positive_mutation: {
      input: 'policy/tenant_policy.csv',
      change: 'delta max_ramp changed from 5 to 10',
      observed: 'CHG-003 for delta changed from rejected to applied and produced a config',
      exit_code: mutationResult.status,
      passed: true,
    },
    negative_case: {
      input: 'changes/patch_queue.jsonl',
      change: 'invalid JSON line appended',
      exit_code: negativeResult.status,
      failed_closed: true,
      generated_reports_absent: !staleReports,
      generated_configs_absent: !staleConfigs,
    },
    line_endings: {
      lf_passed: true,
      crlf_passed: true,
      csv_inputs_tested: ['policy/tenant_policy.csv', 'policy/approvals.csv'],
    },
    linux_executables: [],
    wsl_used: false,
    linux_container_used: false,
    posix_shell_used: false,
  };
  writeEvidence('windows-reproduction.json', evidence);
  process.stdout.write(`${JSON.stringify({ result: 'PASS', node: process.version })}\n`);
}

main().catch((error) => {
  writeEvidence('windows-reproduction-error.json', {
    result: 'FAIL',
    error: error.stack ?? String(error),
    platform: process.platform,
    node_version: process.version,
  });
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

