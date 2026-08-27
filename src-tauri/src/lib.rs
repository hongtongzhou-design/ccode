mod agent_specs;
mod agents;
mod ai;
mod citation;
mod clipboard;
mod config_dump;
mod diagnostics;
mod fonts;mod fs_tree;
mod git_info;
mod global_config;
mod handoff;
mod hooks;
mod journal_metrics;
mod lit_watch;
mod logbuf;
mod mcp;
mod model_registry;
mod models;
mod pdf;
mod portwatch;
mod process;
mod pricing;
mod profiles;
mod profile_validation;
mod projects;
mod pty;
mod reader;
mod scheduler;
mod sessions;
mod settings;
mod skills;
mod updater;
mod usage;
mod workspaces;
mod ws_settings;
mod zotero;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::start_process_monitor();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 应用自更新（tauri-plugin-updater）+ 安装后重启（tauri-plugin-process）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 长任务 OS 通知（注意力跃迁：工作中→待确认/已完成，窗口未聚焦时）
        .plugin(tauri_plugin_notification::init())
        // 产物文件 OS 级拖出（v3.97：把 to-fetch.ris / PDF 从产物核验清单直接拖进 Zotero 等外部应用；
        // WebView 的 HTML5 拖拽出不了窗口，必须走系统拖拽会话）
        .plugin(tauri_plugin_drag::init())
        .manage(profiles::ProfileStore::new().expect("初始化 ProfileStore 失败"))
        .manage(pty::PtyManager::default())
        // 内置技能种子：启动时把库里没有的内置技能补进去（幂等，不覆盖用户已有同名技能）
        .setup(|app| {
            if let Err(e) = skills::seed_builtin_skills() {
                logbuf::record("warn", "skills", &format!("内置技能播种失败: {e}"));
            }
            // 定时雷达：60s tick 调度，启动首 tick 自动补跑关闭期间漏掉的任务
            scheduler::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            profiles::list_profiles,
            profiles::create_profile,
            profiles::update_profile,
            profiles::delete_profile,
            profiles::clear_profile_key,
            profiles::duplicate_profile,
            profiles::copy_profile_to_agent,
            profiles::export_profiles,
            profiles::import_profiles,
            profile_validation::validate_profile,
            agents::detect_agents,
            agents::preview_launch_plan,
            agents::official_account_status,
            agents::clear_account_conflicts,
            agents::session_resume_command,
            agents::resume_external_terminal,
            agents::new_external_terminal,
            agents::session_digest_command,
            agents::digest_external_terminal,
            models::fetch_models,
            model_registry::model_db_status,
            model_registry::download_model_db,
            global_config::apply_profile_global,
            global_config::restore_global_backup,
            global_config::has_global_backup,
            global_config::has_original_backup,
            global_config::restore_original_backup,
            pty::pty_spawn,
            pty::shell_spawn,
            pty::pty_write,
            pty::pty_write_submit,
            pty::pty_resize,
            pty::pty_kill,
            clipboard::save_clipboard_image,
            pty::pty_set_visible,
            pty::pty_get_cwd,
            pty::pty_has_running_process,
            sessions::list_sessions,
            sessions::claim_session_for,
            sessions::release_session_claim,
            sessions::get_session_conversation,
            sessions::get_session_conversation_page,
            sessions::session_file_sig,
            sessions::watch_session,
            sessions::unwatch_session,
            sessions::pin_session,
            sessions::unpin_session,
            sessions::set_session_meta,
            sessions::set_session_profile_command,
            sessions::assign_session_task,
            sessions::claim_next_session_for_card,
            sessions::claim_next_session_for_step,
            sessions::delete_session,
            sessions::delete_project_sessions,
            sessions::session_tail_state,
            sessions::export_session_markdown,
            handoff::handoff_targets,
            handoff::build_handoff_brief,
            handoff::build_session_digest,
            handoff::finalize_digest_brief,
            handoff::list_legacy_briefs,
            handoff::mark_handoff,
            logbuf::get_app_log,
            logbuf::clear_app_log,
            logbuf::export_app_log,
            logbuf::log_event,
            diagnostics::export_diagnostics_bundle,
            config_dump::dump_effective_config,
            config_dump::export_effective_config,
            agent_specs::agent_capabilities,
            model_registry::model_capabilities,
            mcp::list_mcp_servers,
            mcp::save_mcp_server,
            mcp::set_mcp_server_app,
            mcp::set_mcp_server_enabled,
            mcp::delete_mcp_server,
            mcp::check_mcp_server,
            mcp::mcp_agent_status,
            mcp::discover_mcp_servers,
            mcp::import_mcp_from_agent,
            mcp::import_mcp_json,
            mcp::parse_mcp_json,
            fs_tree::list_dir,
            fs_tree::read_file_preview,
            fs_tree::save_file_preview,
            fs_tree::watch_dir,
            fs_tree::unwatch_dir,
            fs_tree::search_files,
            fs_tree::fs_create_dir,
            fs_tree::fs_delete_path,
            fs_tree::home_dir,
            pdf::read_pdf_bytes,
            pdf::read_docx_bytes,
            citation::check_citation_health,
            git_info::git_status,
            git_info::git_file_diff,
            git_info::git_file_hunks,
            git_info::apply_hunk,
            git_info::git_image_pair,
            git_info::git_commit,
            git_info::git_push,
            git_info::git_status_map,
            git_info::project_history,
            git_info::workspace_diff,
            git_info::workspace_file_diff,
            updater::update_agent,
            updater::install_agent,
            updater::install_method_preview,
            updater::updater_write,
            updater::check_agent_updates,
            fonts::font_status,
            fonts::install_font,
            workspaces::create_workspace,
            workspaces::list_workspaces,
            workspaces::archive_workspace,
            workspaces::restore_workspace,
            workspaces::delete_workspace,
            workspaces::workspace_env_for,
            workspaces::register_artifact,
            workspaces::read_artifacts_manifest,
            workspaces::workspace_health,
            workspaces::pending_artifact_checks,
            workspaces::list_human_task_states,
            workspaces::set_human_task_check,
            workspaces::import_human_deliverable,
            workspaces::list_help_requests,
            workspaces::workspace_drift,
            workspaces::workspace_repair_remount,
            workspaces::workspace_relocate_repo,
            workspaces::workspace_mark_archived,
            workspaces::workspace_clean_record,
            workspaces::merge_workspace,
            workspaces::workspace_sync_base,
            workspaces::workspace_unmerged_files,
            workspaces::workspace_conflict_content,
            workspaces::workspace_resolve_file,
            workspaces::workspace_finish_merge,
            workspaces::path_context,
            workspaces::create_pr,
            workspaces::list_repos,
            portwatch::list_listening_ports,
            portwatch::kill_port_process,
            ws_settings::workspace_settings,
            ws_settings::upsert_project_run_scripts,
            projects::list_projects,
            projects::register_project,
            projects::remove_project,
            projects::delete_project_dir,
            projects::purge_project_traces,
            projects::read_project_config,
            projects::write_project_config,
            projects::update_step_skills,
            projects::read_task_draft,
            projects::append_step_draft,
            projects::discover_resources,
            projects::ensure_git_repo,
            projects::commit_project_bootstrap,
            projects::create_demo_project,
            projects::write_workspace_task_md,
            zotero::zotero_inspect,
            zotero::zotero_items,
            zotero::zotero_import,
            projects::pdf_owner_project,
            projects::append_workspace_inbox,
            projects::list_pipeline_templates,
            projects::save_pipeline_template,
            projects::delete_pipeline_template,
            projects::ensure_scratch_dir,
            projects::append_pipeline_steps,
            projects::append_pipeline_steps_with_submission,
            projects::apply_pipeline_template,
            projects::set_pipeline_opt_out,
            projects::fuse_card_into_draft,
            projects::write_task_draft,
            projects::list_task_cards,
            projects::create_task_card,
            projects::rename_task_card,
            projects::delete_task_card,
            skills::list_skills,
            skills::set_skill_category,
            skills::set_skill_tags,
            skills::count_enabled_skills,
            skills::apply_skill,
            skills::delete_skill,
            skills::import_skills_from_dir,
            skills::import_skills_from_zip,
            skills::import_skills_from_github,
            skills::check_skill_updates,
            skills::apply_skill_update,
            skills::check_builtin_skill_updates,
            skills::apply_builtin_skill_update,
            skills::backfill_skill_categories,
            skills::discover_unmanaged,
            skills::import_discovered,
            skills::export_skills,
            skills::read_skill_md,
            skills::create_skill,
            skills::update_skill_content,
            skills::write_skill_md,
            skills::adapt_skill_to_pipeline,
            skills::skill_md_path,
            skills::resync_skill_copies,
            usage::rebuild_usage_index,
            usage::get_usage_stats,
            usage::session_usage,
            usage::profile_usage,
            settings::get_settings,
            settings::app_storage_usage,
            mcp::mcp_distribution_status,
            settings::update_settings,
            hooks::set_hooks_attention,
            hooks::hooks_attention_support,
            hooks::session_confirm_detail,
            ai::ai_prompt,
            ai::ai_commit_message,
            ai::ai_summarize_session,
            ai::ai_draft_pr,
            ai::ai_conflict_advice,
            ai::ai_distill_skill,
            ai::ai_distill_review,
            pricing::read_pricing_file,
            pricing::write_pricing_file,
            scheduler::list_schedules,
            scheduler::create_schedule,
            scheduler::update_schedule,
            scheduler::delete_schedule,
            scheduler::run_schedule_now,
            lit_watch::list_watch_entries,
            lit_watch::list_watch_subscriptions,
            lit_watch::save_watch_subscriptions,
            lit_watch::list_included_entries,
            lit_watch::add_included_entry,
            lit_watch::remove_included_entry,
            lit_watch::download_paper_pdf,
            lit_watch::attach_paper_pdf,
            journal_metrics::journal_metrics_status,
            journal_metrics::download_journal_metrics,
            journal_metrics::check_journal_metrics_update,
            projects::update_lit_watch_filter,
            reader::ensure_paper_note,
            reader::pdf_for_note,
            reader::reader_for_note,
            reader::read_image_bytes,
            reader::save_reader_capture,
            reader::append_note_image,
            reader::list_glossary,
            reader::append_glossary,
            reader::remove_glossary_entry,
            reader::append_note_translation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
