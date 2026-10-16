#!/bin/bash
# =============================================================================
# STELLA - Kubernetes Deployment Script
# =============================================================================
# Unified deployment for local development (macOS/OrbStack) and production (Ubuntu/K3s)
#
# Configuration Wizards:
#   ./scripts/start-k8s.sh --setup            # Onboarding wizard (required vars first)
#   ./scripts/start-k8s.sh --setup --local    # Setup for local development
#   ./scripts/start-k8s.sh --setup --production  # Setup for production
#   ./scripts/start-k8s.sh --config           # Full configuration (all variables)
#   ./scripts/start-k8s.sh --backup           # Guided backup & restore (export/import)
#
# Deployment:
#   ./scripts/start-k8s.sh                    # Local development (auto-detect changes)
#   ./scripts/start-k8s.sh --production       # Production deployment
#   ./scripts/start-k8s.sh --rebuild          # Force rebuild all images
#   ./scripts/start-k8s.sh --skip-build       # Skip builds, restart pods only
#   ./scripts/start-k8s.sh --dry-run          # Preview changes without executing
#   ./scripts/start-k8s.sh --verbose          # Detailed output
#   ./scripts/start-k8s.sh --daemon           # Run in background
#   ./scripts/start-k8s.sh --stop             # Stop all services
#   ./scripts/start-k8s.sh --restart          # Stop then start (apply code changes)
#
# Auto-setup: If no .stella-setup-complete marker exists, the setup wizard
#             will be triggered automatically on first run.
#
# =============================================================================

set -euo pipefail

# =============================================================================
# Error Handling - Show where script failed
# =============================================================================

error_handler() {
    local exit_code=$?
    local line_no=$1
    local command="$2"
    echo ""
    echo -e "\033[31m✗ Script failed at line $line_no\033[0m"
    echo -e "  Command: $command"
    echo -e "  Exit code: $exit_code"
    echo ""
    echo "  Debug: Run with --verbose or check the command manually"
    exit $exit_code
}

trap 'error_handler $LINENO "$BASH_COMMAND"' ERR

# =============================================================================
# Script Setup
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

# Source library modules
source "$LIB_DIR/colors.sh"
source "$LIB_DIR/utils.sh"
source "$LIB_DIR/environment.sh"
source "$LIB_DIR/validation.sh"
source "$LIB_DIR/k3s.sh"
source "$LIB_DIR/build.sh"
source "$LIB_DIR/deploy.sh"

# Override EXIT trap with better debugging (utils.sh sets a basic one)
custom_exit_handler() {
    local exit_code=$?
    local line_no="${BASH_LINENO[0]:-unknown}"

    # Run normal cleanup
    run_cleanup 2>/dev/null || true

    # Show debug info for ANY non-zero exit (helps debug silent failures)
    if [[ $exit_code -ne 0 ]]; then
        echo ""
        echo -e "\033[33m⚠ Script exited with code $exit_code (near line $line_no)\033[0m"
        if [[ "${VERBOSE_MODE:-false}" != "true" ]]; then
            echo "  Run with --verbose for more details"
        else
            echo "  Check the command that failed above"
        fi
    fi
}
trap 'custom_exit_handler' EXIT

# =============================================================================
# Global Variables
# =============================================================================

DAEMON_MODE=false
STOP_MODE=false
RESTART_MODE=false
REBUILD_MODE=false
RESET_DB_MODE=false
SKIP_BUILD_MODE=false
DRY_RUN_MODE=false
VERBOSE_MODE=false
ENV_FLAG=""
SETUP_MODE=false
CONFIG_MODE=false
BACKUP_MODE=false

# =============================================================================
# Argument Parsing (single-pass)
# =============================================================================

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --daemon|-d)
                DAEMON_MODE=true
                ;;
            --stop)
                STOP_MODE=true
                ;;
            --restart|-r)
                RESTART_MODE=true
                ;;
            --rebuild)
                REBUILD_MODE=true
                ;;
            --reset-db)
                RESET_DB_MODE=true
                REBUILD_MODE=true  # reset-db implies rebuild
                ;;
            --skip-build)
                SKIP_BUILD_MODE=true
                ;;
            --dry-run)
                DRY_RUN_MODE=true
                ;;
            --verbose|-v)
                VERBOSE_MODE=true
                ;;
            --local)
                ENV_FLAG="local"
                ;;
            --production)
                ENV_FLAG="production"
                ;;
            --setup)
                SETUP_MODE=true
                ;;
            --config)
                CONFIG_MODE=true
                ;;
            --backup)
                BACKUP_MODE=true
                ;;
            --namespace)
                shift
                KUBERNETES_NAMESPACE="$1"
                ;;
            --port-offset)
                shift
                PORT_OFFSET="$1"
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                error "Unknown option: $1"
                echo ""
                show_help
                exit 1
                ;;
        esac
        shift
    done

    # Export for use in modules
    export DAEMON_MODE STOP_MODE RESTART_MODE REBUILD_MODE RESET_DB_MODE
    export SKIP_BUILD_MODE DRY_RUN_MODE VERBOSE_MODE ENV_FLAG
    export SETUP_MODE CONFIG_MODE
    export KUBERNETES_NAMESPACE PORT_OFFSET
}

show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Configuration Wizards:"
    echo "  --setup         Run onboarding wizard (required variables first)"
    echo "  --config        Run full configuration wizard (all variables)"
    echo "  --backup        Guided backup & restore (export/import the whole system)"
    echo ""
    echo "Environment Options:"
    echo "  --local         Run in local development mode (default)"
    echo "  --production    Run in production mode"
    echo ""
    echo "Namespace Options:"
    echo "  --namespace NS  K8s namespace (default: ai-agents). Non-default auto-offsets ports +100"
    echo "  --port-offset N Override local port offset (default: 0, or 100 for non-default namespace)"
    echo ""
    echo "Deployment Options:"
    echo "  --rebuild       Force rebuild all Docker images"
    echo "  --reset-db      Reset database and rebuild (WARNING: data loss)"
    echo "  --skip-build    Skip builds, restart pods only"
    echo "  --restart, -r   Stop services first, then start (apply code changes)"
    echo "  --dry-run       Preview changes without executing"
    echo "  --verbose, -v   Show detailed output"
    echo "  --daemon, -d    Run in background mode"
    echo "  --stop          Stop all services"
    echo "  --help, -h      Show this help message"
    echo ""
    echo "Setup Examples:"
    echo "  $0 --setup                # Run setup wizard (auto-detect mode)"
    echo "  $0 --setup --local        # Setup for local development"
    echo "  $0 --setup --production   # Setup for production"
    echo "  $0 --config               # Full configuration (all variables)"
    echo ""
    echo "Deployment Examples:"
    echo "  $0                        # Local dev, auto-detect changes"
    echo "  $0 --production           # Production deployment"
    echo "  $0 --rebuild              # Force rebuild everything"
    echo "  $0 --restart -d           # Restart services, run in background"
    echo "  $0 --dry-run --verbose    # Preview with details"
    echo ""
    echo "Parallel Instance Examples:"
    echo "  $0 --namespace ai-agents-review   # Review instance (ports +100)"
    echo "  $0 --namespace ai-agents-review --stop  # Stop only review instance"
}

# =============================================================================
# Main Execution Flow
# =============================================================================

main() {
    # Parse command line arguments
    parse_args "$@"

    # Phase 1: Environment Detection (fast, no I/O)
    detect_environment

    # Phase 1b: Handle wizard modes (before normal startup)
    if [[ "$SETUP_MODE" == "true" ]] || [[ "$CONFIG_MODE" == "true" ]] || [[ "$BACKUP_MODE" == "true" ]]; then
        # Source wizard modules
        source "$LIB_DIR/variables.sh"
        source "$LIB_DIR/wizard.sh"

        if [[ "$SETUP_MODE" == "true" ]]; then
            source "$LIB_DIR/setup_wizard.sh"
            run_setup_wizard "$ENV_FLAG"
            exit $?
        elif [[ "$CONFIG_MODE" == "true" ]]; then
            source "$LIB_DIR/config_wizard.sh"
            run_config_wizard "$ENV_FLAG"
            exit $?
        elif [[ "$BACKUP_MODE" == "true" ]]; then
            source "$LIB_DIR/backup_wizard.sh"
            run_backup_wizard "$ENV_FLAG"
            exit $?
        fi
    fi

    # Display header
    local mode_suffix=""
    [[ "$DRY_RUN_MODE" == "true" ]] && mode_suffix=" ${YELLOW}(DRY RUN)${NC}"
    echo ""
    echo -e "${EMOJI_ROCKET} ${BOLD}STELLA - Kubernetes Deployment${NC}${mode_suffix}"
    echo ""

    # Phase 2: Handle stop mode early
    if [[ "$STOP_MODE" == "true" ]]; then
        stop_services
        exit 0
    fi

    # Phase 2b: Handle restart mode - stop first, then continue with normal startup
    if [[ "$RESTART_MODE" == "true" ]]; then
        info "Restart mode: stopping existing services first..."
        stop_services
        echo ""
    fi

    # Phase 3: Load Configuration
    load_environment

    # Phase 3b: Check if setup is complete, offer wizard if not
    if ! check_setup_status; then
        echo ""
        warning "Setup not complete or missing required configuration"
        echo ""
        echo -e "  ${DIM}Missing required variables or setup marker not found.${NC}"
        echo ""
        echo -e "  Options:"
        echo -e "    ${CYAN}$0 --setup${NC}        Run the setup wizard"
        echo -e "    ${CYAN}$0 --config${NC}       Run full configuration wizard"
        echo ""

        # Ask if user wants to run setup
        read -r -p "  Run setup wizard now? [Y/n] " response
        response="${response:-y}"

        if [[ "$response" =~ ^[Yy]$ ]]; then
            # Source and run wizard
            source "$LIB_DIR/variables.sh"
            source "$LIB_DIR/wizard.sh"
            source "$LIB_DIR/setup_wizard.sh"
            run_setup_wizard "$ENV_FLAG"

            # Inherit the env the wizard picked on its welcome screen
            # (otherwise ENV_FLAG stays empty and load_environment falls
            # back to .env.local even after saving .env.production).
            if [[ -n "${WIZARD_SELECTED_ENV:-}" ]]; then
                ENV_FLAG="$WIZARD_SELECTED_ENV"
                export ENV_FLAG
            fi

            # Reload environment after setup
            load_environment

            # The operator just reconfigured the system; any previously
            # running services were started against the old config (or
            # the wrong env). Stop them before starting fresh so we don't
            # end up with mixed-state pods.
            info "Reconfigured — stopping any running services before fresh start..."
            stop_services
            echo ""

            # After an inline wizard run, deploy in the background so the
            # operator gets their shell back rather than being trapped in
            # a foreground "Press Ctrl+C to stop" loop right after setup.
            if [[ "$DAEMON_MODE" != "true" ]]; then
                info "Post-wizard deploy: switching to daemon mode (-d)"
                DAEMON_MODE=true
                export DAEMON_MODE
            fi
        else
            error "Cannot start without configuration"
            echo ""
            echo -e "  Run: ${CYAN}$0 --setup${NC}"
            exit 1
        fi
    fi

    # Phase 4: Validate Configuration (fail-fast)
    validate_configuration
    validate_build_prerequisites
    validate_k3s_prerequisites

    # Phase 5: Setup K3s
    setup_k3s

    # Phase 6: Setup GPU if enabled (Linux only)
    setup_gpu_support

    # Phase 7: Build Images
    build_images

    # Phase 8: Deploy to Kubernetes
    deploy_services

    # Phase 9: Start Port Forwards
    start_port_forwards

    # Phase 10: Show Summary
    show_summary

    # Phase 11: Handle daemon/foreground mode
    if [[ "$DAEMON_MODE" == "true" ]]; then
        echo ""
        info "Running in daemon mode - use '$0 --stop' to stop"
        exit 0
    else
        # Foreground mode: wait for Ctrl+C
        if [[ "$DRY_RUN_MODE" != "true" ]]; then
            echo ""
            info "Press Ctrl+C to stop"

            # Wait for interrupt
            trap cleanup INT TERM
            while true; do
                sleep 60
            done
        fi
    fi
}

cleanup() {
    echo ""
    info "Shutting down..."
    stop_services
    exit 0
}

# =============================================================================
# Run Main
# =============================================================================

# Sourcing the script (scripts/namespace-flag-test.sh) loads its functions only.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
