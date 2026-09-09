//! 科研复现运行记录与验收决定：与 Git 合并分开，不把报告文字当成通过。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN_TIMEOUT: Duration = Duration::from_secs(600);
const OUTPUT_CAP: usize = 256 * 1024;
const FILE_LIST_CAP: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRunDto {
    pub id: String,
    pub workspace_id: String,
    pub worktree_path: String,
    pub command: Vec<String>,
    pub entry: String,
    pub entry_revision: Option<String>,
    pub input: String,
    pub output_dir: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub outputs: Vec<String>,
    pub result_file: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAcceptedFile {
    pub path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAcceptanceDto {
    pub verdict: String,
    pub step_name: String,
    pub workspace_id: String,
    pub files: Vec<ResearchAcceptedFile>,
    pub conclusion_scope: String,
    pub open_blockers: Vec<String>,
    pub run_id: Option<String>,
    pub created_at: String,
}

fn reproductions_root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("无法确定用户主目录")?
        .join("ccode")
        .join("reproductions"))
}

fn safe_id(value: &str) -> Result<String, String> {
    let cleaned: String = value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    crate::paths::sanitize_fs_name(&cleaned)
}

fn run_dir(workspace_id: &str, run_id: &str) -> Result<PathBuf, String> {
    Ok(reproductions_root()?
        .join(safe_id(workspace_id)?)
        .join(safe_id(run_id)?))
}

fn load_run(path: &Path) -> Result<ResearchRunDto, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("读取运行记录失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("运行记录损坏: {e}"))
}

fn save_run(dir: &Path, run: &ResearchRunDto) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建运行目录失败: {e}"))?;
    crate::profiles::atomic_write(&dir.join("run.json"), &serde_json::to_string_pretty(run).map_err(|e| e.to_string())?)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取入口失败: {e}"))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn list_outputs(root: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
        if out.len() >= FILE_LIST_CAP {
            return Ok(());
        }
        let entries = match fs::read_dir(dir) {
            Ok(v) => v,
            Err(e) => return Err(format!("列举输出失败: {e}")),
        };
        for entry in entries {
            let entry = entry.map_err(|e| format!("列举输出失败: {e}"))?;
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some("run.json") {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if out.len() >= FILE_LIST_CAP {
                break;
            }
        }
        Ok(())
    }
    walk(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

fn python_bin() -> Result<PathBuf, String> {
    crate::agents::resolve_binary("python3")
        .or_else(|| crate::agents::resolve_binary("python"))
        .ok_or_else(|| "未找到 python3/python，无法执行复现脚本".into())
}

fn active_workspace(id: &str, worktree: &Path) -> Result<crate::workspaces::WorkspaceDto, String> {
    let conn = crate::workspaces::db()?;
    let ws = crate::workspaces::get_workspace(&conn, id)?;
    if ws.status != "active" {
        return Err("工作区已归档或未激活，不能运行复现".into());
    }
    let tree = crate::paths::canonicalize_plain(Path::new(&ws.worktree_path))
        .map_err(|e| format!("工作区路径无效: {e}"))?;
    let given = crate::paths::canonicalize_plain(worktree).map_err(|e| format!("工作区路径无效: {e}"))?;
    if !crate::paths::path_within_path(&given, &tree) || !crate::paths::path_within_path(&tree, &given) {
        return Err("工作区路径已变化，不能运行复现".into());
    }
    Ok(ws)
}

#[tauri::command]
pub async fn research_run_reproduce(
    workspace_id: String,
    worktree_path: String,
    entry: String,
    subcommand: Option<String>,
    result_file: Option<String>,
) -> Result<ResearchRunDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ws = active_workspace(&workspace_id, Path::new(&worktree_path))?;
        let tree = crate::paths::canonicalize_plain(Path::new(&ws.worktree_path))
            .map_err(|e| format!("工作区路径无效: {e}"))?;
        let rel = entry.trim().replace('\\', "/");
        if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|p| p == ".." || p == ".") {
            return Err("复现入口必须是项目内相对路径".into());
        }
        let script = tree.join(&rel);
        if !crate::paths::path_within_path(&crate::paths::canonicalize_plain(&script).map_err(|e| format!("复现入口无效: {e}"))?, &tree) {
            return Err("复现入口不在工作区内".into());
        }
        if !script.is_file() {
            return Err("复现入口不是文件".into());
        }
        let revision = sha256_file(&script)?;
        let run_id = format!("r-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let out = run_dir(&workspace_id, &run_id)?;
        if out.exists() {
            return Err("运行目录已存在".into());
        }
        if crate::paths::path_within_path(&out, &tree) || crate::paths::path_within_path(&tree, &out) {
            return Err("输出必须独立于输入项目".into());
        }
        fs::create_dir_all(&out).map_err(|e| format!("创建输出目录失败: {e}"))?;
        let python = python_bin()?;
        let mut args = vec![rel.clone()];
        if let Some(cmd) = subcommand.as_ref().filter(|s| !s.trim().is_empty()) {
            args.push(cmd.trim().to_string());
        }
        args.extend([
            "--input".into(),
            tree.to_string_lossy().into_owned(),
            "--output".into(),
            out.to_string_lossy().into_owned(),
        ]);
        let mut command_line = vec![python.to_string_lossy().into_owned()];
        command_line.extend(args.iter().cloned());
        let started = crate::sessions::now_iso();
        let mut run = ResearchRunDto {
            id: run_id.clone(),
            workspace_id: workspace_id.clone(),
            worktree_path: tree.to_string_lossy().into_owned(),
            command: command_line,
            entry: rel,
            entry_revision: Some(revision),
            input: tree.to_string_lossy().into_owned(),
            output_dir: out.to_string_lossy().into_owned(),
            status: "running".into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            outputs: Vec::new(),
            result_file: result_file.filter(|s| !s.trim().is_empty()),
            started_at: started,
            finished_at: None,
        };
        save_run(&out, &run)?;
        let mut cmd = crate::process::background_command(&python);
        cmd.current_dir(&tree);
        cmd.args(&args);
        let captured = crate::process::capture_command(&mut cmd, RUN_TIMEOUT, OUTPUT_CAP)?;
        run.stdout = String::from_utf8_lossy(&captured.stdout).into_owned();
        run.stderr = String::from_utf8_lossy(&captured.stderr).into_owned();
        run.finished_at = Some(crate::sessions::now_iso());
        run.exit_code = captured.status.and_then(|s| s.code());
        run.status = if captured.timed_out {
            "failed".into()
        } else if captured.status.map(|s| s.success()).unwrap_or(false) {
            "succeeded".into()
        } else if run.stderr.contains("BLOCKED:") {
            "blocked".into()
        } else {
            "failed".into()
        };
        if captured.timed_out {
            run.stderr = format!("运行超时（{} 秒）。\n{}", RUN_TIMEOUT.as_secs(), run.stderr);
        }
        run.outputs = list_outputs(&out).unwrap_or_default();
        save_run(&out, &run)?;
        Ok(run)
    })
    .await
    .map_err(|e| format!("复现运行失败: {e}"))?
}

#[tauri::command]
pub async fn research_get_run(workspace_id: String, run_id: String) -> Result<ResearchRunDto, String> {
    tauri::async_runtime::spawn_blocking(move || load_run(&run_dir(&workspace_id, &run_id)?.join("run.json")))
        .await
        .map_err(|e| format!("读取运行记录失败: {e}"))?
}

#[tauri::command]
pub async fn research_read_run_file(
    workspace_id: String,
    run_id: String,
    path: String,
) -> Result<crate::fs_tree::FilePreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = run_dir(&workspace_id, &run_id)?;
        let rel = path.trim().replace('\\', "/");
        if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|p| p == ".." || p.is_empty()) {
            return Err("结果路径必须是本次输出内的相对路径".into());
        }
        let file = dir.join(&rel);
        let canon = crate::paths::canonicalize_plain(&file).map_err(|e| format!("结果文件不存在: {e}"))?;
        let root = crate::paths::canonicalize_plain(&dir).map_err(|e| format!("运行目录无效: {e}"))?;
        if !crate::paths::path_within_path(&canon, &root) {
            return Err("结果文件不在本次输出目录内".into());
        }
        crate::fs_tree::read_file_preview_sync(&canon.to_string_lossy(), &root.to_string_lossy())
    })
    .await
    .map_err(|e| format!("读取结果失败: {e}"))?
}

fn acceptance_path(root: &Path) -> PathBuf {
    root.join(".ccode").join("research-acceptance.json")
}

fn load_acceptances(root: &Path) -> Result<Vec<ResearchAcceptanceDto>, String> {
    let path = acceptance_path(root);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取验收记录失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("验收记录损坏: {e}"))
}

#[tauri::command]
pub async fn research_save_acceptance(
    project_root: String,
    record: ResearchAcceptanceDto,
) -> Result<ResearchAcceptanceDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(record.verdict.as_str(), "accept" | "accept_with_conditions" | "return") {
            return Err("验收决定必须是接受、有条件接受或退回".into());
        }
        if record.conclusion_scope.trim().is_empty() {
            return Err("请写明接受的结论范围".into());
        }
        let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        let mut rows = load_acceptances(&root)?;
        let mut saved = record;
        saved.created_at = crate::sessions::now_iso();
        rows.retain(|r| !(r.workspace_id == saved.workspace_id && r.step_name == saved.step_name));
        rows.push(saved.clone());
        let dir = root.join(".ccode");
        fs::create_dir_all(&dir).map_err(|e| format!("创建项目记录目录失败: {e}"))?;
        crate::profiles::atomic_write(
            &acceptance_path(&root),
            &serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?,
        )?;
        Ok(saved)
    })
    .await
    .map_err(|e| format!("保存验收决定失败: {e}"))?
}

#[tauri::command]
pub async fn research_get_acceptance(
    project_root: String,
    workspace_id: String,
    step_name: String,
) -> Result<Option<ResearchAcceptanceDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::projects::ensure_task_project_root(Path::new(&crate::sessions::expand_tilde(&project_root)))?;
        Ok(load_acceptances(&root)?
            .into_iter()
            .rev()
            .find(|r| r.workspace_id == workspace_id && r.step_name == step_name))
    })
    .await
    .map_err(|e| format!("读取验收决定失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_reproduce_writes_independent_result() {
        let tmp = std::env::temp_dir().join(format!("mesa-repro-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(tmp.join("experiments")).unwrap();
        let script = tmp.join("experiments/reproduce.py");
        fs::write(
            &script,
            "import argparse, json, pathlib\nparser=argparse.ArgumentParser()\nsub=parser.add_subparsers(dest='command',required=True)\nr=sub.add_parser('reproduce')\nr.add_argument('--input',required=True)\nr.add_argument('--output',required=True)\na=parser.parse_args()\nout=pathlib.Path(a.output)\nout.mkdir(parents=True,exist_ok=True)\n(out/'verification.json').write_text(json.dumps({'ok':True}))\n",
        )
        .unwrap();
        let python = python_bin().unwrap();
        let out = tmp.join("outside");
        let mut cmd = crate::process::background_command(&python);
        cmd.current_dir(&tmp);
        cmd.args([
            "experiments/reproduce.py",
            "reproduce",
            "--input",
            tmp.to_str().unwrap(),
            "--output",
            out.to_str().unwrap(),
        ]);
        let captured = crate::process::capture_command(&mut cmd, Duration::from_secs(20), 4096).unwrap();
        assert!(captured.status.unwrap().success(), "{}", String::from_utf8_lossy(&captured.stderr));
        assert!(out.join("verification.json").is_file());
        assert!(!tmp.join("verification.json").exists());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_ids_with_hyphens_are_safe_directory_names() {
        let name = safe_id("6ba7b810-9dad-11d1-80b4-00c04fd430c8").unwrap();
        assert!(crate::paths::validate_fs_name(&name).is_ok(), "{name}");
        assert_eq!(safe_id("r-abc123").unwrap(), "r-abc123");
    }
}
