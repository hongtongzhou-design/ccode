mod agents;
mod global_config;
mod models;
mod profiles;
mod pty;
mod sessions;

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
            sessions::list_sessions,
            sessions::find_session_for,
            sessions::get_session_conversation,
            sessions::pin_session,
            sessions::unpin_session,
            sessions::set_session_meta,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
