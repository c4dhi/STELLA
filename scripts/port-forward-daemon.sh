#!/bin/bash

# Robust Port-Forward Daemon for Local Development
# Uses automatic restart with exponential backoff and health checks
#
# Usage:
#   ./port-forward-daemon.sh start      # Start in foreground (Ctrl+C to stop)
#   ./port-forward-daemon.sh start -d   # Start in background (daemon mode)
#   ./port-forward-daemon.sh stop       # Stop all port-forwards
#   ./port-forward-daemon.sh status     # Check status
#   ./port-forward-daemon.sh logs       # View logs

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration (inherit from environment or use defaults)
NAMESPACE="${KUBERNETES_NAMESPACE:-ai-agents}"
_ns_suffix=""
[[ "$NAMESPACE" != "ai-agents" ]] && _ns_suffix="-${NAMESPACE}"
# start-k8s.sh exports its PID_DIR; use it, so its --stop finds our pid file.
PID_DIR="${PID_DIR:-${STELLA_AI_TEMP_DIR:-/tmp}/stella-ai-k8s${_ns_suffix}}"
FOREGROUND=true  # Default to foreground mode
mkdir -p "$PID_DIR"

# Services to port-forward: "service:local_port:remote_port"
SERVICES=(
    "frontend-ui:${FRONTEND_PORT:-8080}:8080"
    "session-management-server:${BACKEND_PORT:-3000}:3000"
    "postgres:${POSTGRES_PORT:-5432}:5432"
)

# Child PIDs for cleanup
CHILD_PIDS=()

# Cleanup function for Ctrl+C
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down port-forwards...${NC}"

    # Kill all child processes
    for pid in "${CHILD_PIDS[@]}"; do
        if ps -p "$pid" > /dev/null 2>&1; then
            pkill -P "$pid" 2>/dev/null || true
            kill "$pid" 2>/dev/null || true
        fi
    done

    # Also kill any stray kubectl port-forward processes we started
    pkill -f "kubectl port-forward -n $NAMESPACE " 2>/dev/null || true

    # Clean up PID file
    rm -f "$PID_DIR/daemon-pids.txt"

    echo -e "${GREEN}All port-forwards stopped${NC}"
    exit 0
}

# Set up trap for Ctrl+C and termination
trap cleanup SIGINT SIGTERM

# Function to start a single port-forward with auto-restart
start_port_forward_loop() {
    local service=$1
    local local_port=$2
    local remote_port=$3
    local log_file="$PID_DIR/pf-${service}.log"
    local backoff=1
    local max_backoff=60
    local last_start_time=0

    # Disable set -e in this function - we expect kubectl to fail and want to handle it
    set +e

    # Run kubectl and sleep in the background and `wait` for them: bash only
    # runs a trap once a foreground child returns, so SIGTERM used to be
    # ignored for as long as the forward stayed up (#737). On TERM/INT, end the
    # current child and the loop.
    local child=""
    trap 'kill "$child" 2>/dev/null; exit 0' TERM INT

    echo "[$(date '+%H:%M:%S')] Starting port-forward loop for $service" >> "$log_file"

    while true; do
        echo "[$(date '+%H:%M:%S')] Connecting $service:$remote_port -> localhost:$local_port" >> "$log_file"
        last_start_time=$(date +%s)

        # Run kubectl port-forward (wait blocks until it dies)
        kubectl port-forward -n "$NAMESPACE" \
            --address 127.0.0.1 \
            "svc/$service" "$local_port:$remote_port" >> "$log_file" 2>&1 &
        child=$!
        wait "$child"

        exit_code=$?
        current_time=$(date +%s)
        runtime=$((current_time - last_start_time))

        echo "[$(date '+%H:%M:%S')] Port-forward died (exit: $exit_code, ran for ${runtime}s), restarting in ${backoff}s..." >> "$log_file"

        sleep $backoff &
        child=$!
        wait "$child"

        # Exponential backoff up to max
        backoff=$((backoff * 2))
        if [ $backoff -gt $max_backoff ]; then
            backoff=$max_backoff
        fi

        # Reset backoff if connection was stable (ran for more than 30 seconds)
        if [ $runtime -gt 30 ]; then
            backoff=1
        fi
    done
}

start_all() {
    echo -e "${YELLOW}Starting port-forward daemons...${NC}"

    # Kill any existing port-forwards
    stop_all 2>/dev/null || true

    # Start each service in background
    for svc_config in "${SERVICES[@]}"; do
        IFS=':' read -r service local_port remote_port <<< "$svc_config"

        # Start in background.
        #
        # In daemon mode this MUST leave the caller's session, not just the
        # foreground. A plain `&` keeps the child in the same process group,
        # so it dies with its parent -- which under a GitHub Actions runner
        # means the forwards are torn down seconds after the deploy job
        # reports success, and the site goes down. setsid detaches into a new
        # session so the loop outlives the job (and an SSH logout).
        local pid
        if [ "$FOREGROUND" = true ]; then
            start_port_forward_loop "$service" "$local_port" "$remote_port" &
            pid=$!
        else
            # env -u RUNNER_TRACKING_ID is load-bearing, not tidiness.
            #
            # setsid alone is not enough under GitHub Actions. At job end the
            # runner sweeps /proc and kills every process whose environment
            # still carries the job's RUNNER_TRACKING_ID, regardless of session
            # or parent. Children inherit it, so a setsid'd forward was still
            # matched and killed -- observed on the first production deploy,
            # which shipped the setsid fix and still lost its forwards.
            # Dropping the variable makes the loop invisible to that sweep.
            setsid env -u RUNNER_TRACKING_ID \
                nohup "$0" _forward-loop "$service" "$local_port" "$remote_port" \
                >/dev/null 2>&1 < /dev/null &
            pid=$!
        fi
        CHILD_PIDS+=($pid)
        echo "$pid" >> "$PID_DIR/daemon-pids.txt"
        echo -e "  ${GREEN}✓${NC} $service -> localhost:$local_port (PID: $pid)"
    done

    echo ""
    echo -e "${GREEN}All port-forwards started with auto-restart${NC}"
    echo -e "Logs: $PID_DIR/pf-*.log"

    if [ "$FOREGROUND" = true ]; then
        echo ""
        echo -e "${YELLOW}Running in foreground. Press Ctrl+C to stop.${NC}"
        echo ""

        # Wait for all children (blocks until Ctrl+C)
        wait
    else
        echo -e "Stop: $0 stop"
    fi
}

stop_all() {
    echo -e "${YELLOW}Stopping port-forward daemons...${NC}"

    # Kill daemon loops. Read the pid file in one go first: rm -f, because
    # the file must not decide whether the remaining loops are stopped (#737).
    if [ -f "$PID_DIR/daemon-pids.txt" ]; then
        local pids
        pids=$(cat "$PID_DIR/daemon-pids.txt")
        rm -f "$PID_DIR/daemon-pids.txt"
        for pid in $pids; do
            if ps -p "$pid" > /dev/null 2>&1; then
                kill "$pid" 2>/dev/null || true
                pkill -P "$pid" 2>/dev/null || true
                echo -e "  ${GREEN}✓${NC} Stopped daemon PID: $pid"
            fi
        done
    fi

    # Also kill any stray kubectl port-forward processes. The space after the
    # namespace matters: without it, stopping ai-agents also hit ai-agents-*.
    pkill -f "kubectl port-forward -n $NAMESPACE " 2>/dev/null || true

    echo -e "${GREEN}All port-forwards stopped${NC}"
}

show_status() {
    echo "Port-Forward Status"
    echo "==================="

    for svc_config in "${SERVICES[@]}"; do
        IFS=':' read -r service local_port remote_port <<< "$svc_config"

        # Check if port is listening
        if lsof -i ":$local_port" > /dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} $service -> localhost:$local_port"
        else
            echo -e "  ${RED}✗${NC} $service -> localhost:$local_port (not listening)"
        fi
    done

    echo ""

    # Show daemon PIDs
    if [ -f "$PID_DIR/daemon-pids.txt" ]; then
        echo "Daemon PIDs:"
        while read pid; do
            if [ ! -z "$pid" ]; then
                if ps -p "$pid" > /dev/null 2>&1; then
                    echo -e "  ${GREEN}●${NC} $pid (running)"
                else
                    echo -e "  ${RED}●${NC} $pid (dead)"
                fi
            fi
        done < "$PID_DIR/daemon-pids.txt"
    else
        echo "No daemons running"
    fi
}

show_logs() {
    echo "Tailing logs (Ctrl+C to stop)..."
    echo ""
    tail -f "$PID_DIR"/pf-*.log 2>/dev/null || echo "No logs found"
}

case "${1:-}" in
    start)
        # Check for -d flag (daemon mode)
        if [ "${2:-}" = "-d" ] || [ "${2:-}" = "--daemon" ]; then
            FOREGROUND=false
        fi
        start_all
        ;;
    stop)
        stop_all
        ;;
    restart)
        # Check for -d flag (daemon mode)
        if [ "${2:-}" = "-d" ] || [ "${2:-}" = "--daemon" ]; then
            FOREGROUND=false
        fi
        stop_all
        sleep 1
        start_all
        ;;
    _forward-loop)
        # Internal: one detached forward loop, re-entered via setsid above.
        # Not part of the public interface, hence the leading underscore.
        start_port_forward_loop "$2" "$3" "$4"
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs} [-d|--daemon]"
        echo ""
        echo "Commands:"
        echo "  start         Start port-forwards in foreground (Ctrl+C to stop)"
        echo "  start -d      Start port-forwards in background (daemon mode)"
        echo "  stop          Stop all port-forwards"
        echo "  restart       Restart all port-forwards (foreground)"
        echo "  restart -d    Restart all port-forwards (daemon mode)"
        echo "  status        Show current status"
        echo "  logs          Tail all port-forward logs"
        echo ""
        echo "Features:"
        echo "  - Auto-restarts if port-forward dies"
        echo "  - Exponential backoff on failures"
        echo "  - Ctrl+C gracefully stops all in foreground mode"
        exit 1
        ;;
esac
