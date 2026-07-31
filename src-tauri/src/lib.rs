mod agents;
mod fs_tree;
mod git_info;
mod global_config;
mod models;
mod profiles;
mod pty;
mod sessions;
mod skills;
mod updater;
mod usage;
mod workspaces;
mod ws_settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(profiles::ProfileStore::new().expect("初始化 ProfileStore 失败"))
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            profiles::list_profiles,
            profiles::create_profile,
            profiles::update_profile,
            profiles::delete_profile,
            profiles::duplicate_profile,
            profiles::export_profiles,
            profiles::import_profiles,
            agents::detect_agents,
            models::fetch_models,
            global_config::apply_profile_global,
            global_config::restore_global_backup,
            global_config::has_global_backup,
            pty::pty_spawn,
            pty::shell_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_set_visible,
            sessions::list_sessions,
            sessions::find_session_for,
            sessions::get_session_conversation,
            sessions::pin_session,
            sessions::unpin_session,
            sessions::set_session_meta,
            sessions::delete_session,
            sessions::delete_project_sessions,
            fs_tree::list_dir,
            fs_tree::read_file_preview,
            git_info::git_status,
            git_info::git_commit,
            git_info::git_push,
            git_info::workspace_diff,
            updater::update_agent,
            updater::install_agent,
            updater::install_method_preview,
            updater::updater_write,
            workspaces::create_workspace,
            workspaces::list_workspaces,
            workspaces::archive_workspace,
            workspaces::restore_workspace,
            workspaces::delete_workspace,
            workspaces::workspace_env_for,
            workspaces::workspace_health,
            workspaces::merge_workspace,
            workspaces::create_pr,
            workspaces::list_repos,
            ws_settings::workspace_settings,
            skills::list_skills,
            skills::apply_skill,
            skills::delete_skill,
            skills::import_skills_from_dir,
            skills::import_skills_from_zip,
            skills::import_skills_from_github,
            skills::discover_unmanaged,
            skills::import_discovered,
            skills::export_skills,
            skills::read_skill_md,
            usage::rebuild_usage_index,
            usage::get_usage_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
