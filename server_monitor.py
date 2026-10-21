"""
Election Night Results - Folder Monitor Server Script
Monitors the 'Results/' folder for new or modified CSV files and automatically re-compiles data.js.
"""

import os
import sys
import time
import subprocess
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(BASE_DIR, 'Results')
CONVERT_SCRIPT = os.path.join(BASE_DIR, 'convert_data.py')
INDEX_HTML = os.path.join(BASE_DIR, 'index.html')

def get_folder_snapshot(folder_path):
    """Returns a dictionary mapping normalized relative CSV paths to (mtime, ctime, size) tuples."""
    snapshot = {}
    if os.path.exists(folder_path):
        for root, _, files in os.walk(folder_path):
            for fname in files:
                if fname.upper().endswith('.CSV'):
                    fpath = os.path.join(root, fname)
                    rel_path = os.path.relpath(fpath, folder_path).upper()
                    try:
                        stat = os.stat(fpath)
                        snapshot[rel_path] = (stat.st_mtime, stat.st_ctime, stat.st_size)
                    except OSError:
                        pass
    return snapshot

def run_conversion():
    """Triggers convert_data.py execution."""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"\n[{timestamp}] [MONITOR] Change detected in Results/. Triggering convert_data.py...", flush=True)
    try:
        result = subprocess.run([sys.executable, CONVERT_SCRIPT], capture_output=True, text=True, cwd=BASE_DIR)
        if result.stdout:
            print(result.stdout, flush=True)
        if result.stderr:
            print(f"[{timestamp}] [WARNING/STDERR]:\n{result.stderr}", flush=True)
        if result.returncode == 0:
            print(f"[{timestamp}] [MONITOR] Conversion & Verification SUCCESSFUL.", flush=True)
            try:
                webbrowser.open(os.path.abspath(INDEX_HTML))
            except Exception as e:
                print(f"[{timestamp}] [WARNING] Failed to open index.html: {e}", flush=True)
        else:
            print(f"[{timestamp}] [ERROR] Conversion exited with code {result.returncode}.", flush=True)
    except Exception as e:
        print(f"[{timestamp}] [ERROR] Failed to run convert_data.py: {e}", flush=True)

def print_inventory(snapshot, header="CSV FILE INVENTORY"):
    """Prints formatted list of monitored CSV files with modification timestamps and sizes."""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"\n--- [{timestamp}] {header} ({len(snapshot)} file(s)) ---", flush=True)
    if not snapshot:
        print("  (No CSV files currently in Results/ directory)", flush=True)
    else:
        for rel_path, (mtime, ctime, size) in sorted(snapshot.items()):
            mod_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(mtime))
            print(f"  • {rel_path:<35} | Last Modified: {mod_str} | Size: {size:,} bytes", flush=True)
    print("-" * 65, flush=True)

def monitor_loop(poll_interval=2, heartbeat_sec=30):
    """Continuously monitors relative Results/ directory for file changes."""
    rel_results = "Results/"
    abs_results = os.path.abspath(RESULTS_DIR)
    print("=" * 65)
    print(" ELECTION NIGHT RESULTS - AUTOMATIC FOLDER MONITOR SERVER")
    print(f" Monitored Path:  {rel_results} ({abs_results})")
    print(f" Converter:       convert_data.py")
    print(" Press Ctrl+C to stop the monitor server.")
    print("=" * 65)

    if not os.path.exists(RESULTS_DIR):
        os.makedirs(RESULTS_DIR, exist_ok=True)

    # Initial snapshot & display
    last_snapshot = get_folder_snapshot(RESULTS_DIR)
    print_inventory(last_snapshot, header="INITIAL FILE SNAPSHOT")
    
    # Run initial conversion on start
    run_conversion()
    last_heartbeat = time.time()

    while True:
        try:
            time.sleep(poll_interval)
            current_snapshot = get_folder_snapshot(RESULTS_DIR)
            now = time.time()

            # Check if files were added, deleted, or updated
            if current_snapshot != last_snapshot:
                added = set(current_snapshot.keys()) - set(last_snapshot.keys())
                removed = set(last_snapshot.keys()) - set(current_snapshot.keys())
                modified = {k for k in current_snapshot if k in last_snapshot and current_snapshot[k] != last_snapshot[k]}

                if added:
                    print(f"[MONITOR] New CSV file(s) added: {', '.join(added)}", flush=True)
                if removed:
                    print(f"[MONITOR] CSV file(s) removed: {', '.join(removed)}", flush=True)
                if modified:
                    print(f"[MONITOR] CSV file(s) modified: {', '.join(modified)}", flush=True)

                time.sleep(0.5) # Brief pause for file write stabilization
                run_conversion()
                last_snapshot = current_snapshot
                print_inventory(current_snapshot, header="UPDATED FILE SNAPSHOT")
                last_heartbeat = now
            elif now - last_heartbeat >= heartbeat_sec:
                print_inventory(current_snapshot, header="STATUS PULSE (STILL MONITORING)")
                last_heartbeat = now

        except KeyboardInterrupt:
            print("\n[MONITOR] Server monitor stopped by user.", flush=True)
            sys.exit(0)
        except Exception as e:
            print(f"[MONITOR ERROR] {e}", flush=True)
            time.sleep(poll_interval)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--once':
        run_conversion()
    else:
        monitor_loop()
