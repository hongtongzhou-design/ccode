mod agents;
mod ai;
mod fs_tree;
mod git_info;
mod global_config;
mod logbuf;
mod models;
mod pricing;
mod profiles;
mod pty;
mod sessions;
mod settings;
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
            sessions::session_file_sig,
            sessions::pin_session,
            sessions::unpin_session,
            sessions::set_session_meta,
            sessions::delete_session,
            sessions::delete_project_sessions,
            sessions::session_tail_state,
            sessions::export_session_markdown,
            logbuf::get_app_log,
            logbuf::clear_app_log,
            logbuf::log_event,
            fs_tree::list_dir,
            fs_tree::read_file_preview,
            fs_tree::save_file_preview,
            fs_tree::watch_dir,
            fs_tree::unwatch_dir,
            fs_tree::search_files,
            fs_tree::fs_create_dir,
            fs_tree::fs_delete_path,
            git_info::git_status,
            git_info::git_commit,
            git_info::git_push,
            git_info::git_status_map,
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
            skills::set_skill_category,
            skills::count_enabled_skills,
            skills::apply_skill,
            skills::delete_skill,
            skills::import_skills_from_dir,
            skills::import_skills_from_zip,
            skills::import_skills_from_github,
            skills::discover_unmanaged,
            skills::import_discovered,
            skills::export_skills,
            skills::read_skill_md,
            skills::resync_skill_copies,
            usage::rebuild_usage_index,
            usage::get_usage_stats,
            usage::profile_usage,
            settings::get_settings,
            settings::update_settings,
            ai::ai_prompt,
            ai::ai_commit_message,
            ai::ai_summarize_session,
            ai::ai_draft_pr,
            pricing::read_pricing_file,
            pricing::write_pricing_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
