#!/usr/bin/env bash
#
# Guided Backup & Restore wizard (#378).
#
# A thin interactive menu over the standalone backup-export.sh /
# backup-restore.sh scripts, so an operator can back up or relocate the system
# without remembering flags. The scripts themselves still do all the real work
# (preflights, passphrase prompts, confirmations) — this only collects the
# high-level choices and dispatches.
#
# Entry point: run_backup_wizard "$ENV_FLAG"

# Clear the screen and redraw the header. Called before every prompt so each
# step replaces the previous one instead of stacking (matching setup/config).
_backup_wizard_header() {
    wizard_clear_screen
    echo -e "\n  ${BOLD}STELLA — Backup & Restore${NC}"
    echo -e "  ${DIM}Export the whole deployment to a portable bundle, or restore one onto this machine.${NC}\n"
}

run_backup_wizard() {
    local env_flag="${1:-}"
    local env_arg=""
    [[ -n "$env_flag" ]] && env_arg="--$env_flag"

    # This file lives in scripts/lib/ — the backup scripts are one level up.
    local scripts_dir
    scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

    _backup_wizard_header
    local action
    action="$(wizard_select_input \
        "What would you like to do?" \
        "Export creates a bundle to keep or move. Restore OVERWRITES this deployment from a bundle." \
        "Export" \
        "Export,Restore,Cancel")"

    case "$action" in
        Export)
            # Encryption is NOT offered as a choice here. The bundle holds every
            # secret, and a boolean prompt is a single arrow key — which would
            # reduce the deliberate two-flag gate on the export script to one
            # keystroke. An operator who genuinely needs a plaintext bundle can
            # run backup-export.sh with --no-encrypt --allow-plaintext-config.
            _backup_wizard_header
            local met
            met="$(wizard_boolean_input \
                "Include metrics & logs?" \
                "Larger bundle; usually not needed to restore a working system." \
                "false")"

            local args=()
            [[ -n "$env_arg" ]] && args+=("$env_arg")
            [[ "$met" == "true" ]] && args+=("--include-metrics")

            _backup_wizard_header
            info "Starting export — the system must be running."
            info "The bundle will be encrypted; you'll be asked for a passphrase."
            echo
            "$scripts_dir/backup-export.sh" "${args[@]}"
            ;;

        Restore)
            _backup_wizard_header
            local bundle
            bundle="$(wizard_text_input \
                "Path to the backup bundle" \
                "e.g. ./stella-backup-20260101-120000.zip (or .zip.enc)" \
                "" "")"
            if [[ -z "$bundle" ]]; then
                _backup_wizard_header
                error "No bundle path provided — aborting restore."
                return 1
            fi
            if [[ ! -f "$bundle" ]]; then
                _backup_wizard_header
                error "File not found: $bundle"
                return 1
            fi

            local args=("--in" "$bundle")
            [[ -n "$env_arg" ]] && args+=("$env_arg")

            _backup_wizard_header
            warning "Restore OVERWRITES all data and config in this deployment."
            info "You'll be asked to confirm (and for the passphrase, if encrypted) before anything changes."
            echo
            "$scripts_dir/backup-restore.sh" "${args[@]}"
            ;;

        *)
            _backup_wizard_header
            info "Cancelled — nothing was changed."
            ;;
    esac
}
