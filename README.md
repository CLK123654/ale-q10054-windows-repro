# 功能开关变更的Node.js租户发布编排

这个仓库保存本题正文、四个最终附件、完成后的Node.js源码和独立Windows门禁。输入包含功能开关基线、补丁队列、租户策略、审批表和发布合同。发布编排源码负责逐租户裁决变更，生成发布报告与实际配置。

四个附件位于artifacts目录，任务正文位于task目录，完成后的源码位于candidate目录。工作流使用windows-2025和Node.js24，在两个带中文和空格的新目录中各运行两次，还会检查租户灰度上限变化、损坏的补丁队列和CRLF换行。

在Windows PowerShell中执行：

    ./scripts/windows_gate.ps1 -RepositoryRoot $PWD -EvidenceRoot $env:TEMP/ale-q10054-evidence

工作流安装Node.js时需要联网。业务运行阶段只读取本地文件，不访问外部服务。
