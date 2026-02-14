use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

fn usage() -> ! {
  eprintln!(
    r#"framectl

Usage:
  framectl build [--start=N] [--end=N] [--concurrency=N] [--silent=0|1] [--dry-run=0|1]

Notes:
  - Builds pnpm workspace packages named @bad-apple/frame-XXXX (4 digits).
  - If --end is omitted, inferred from apps/frames/frame-XXXX dirs.
"#
  );
  std::process::exit(2);
}

fn parse_bool(s: &str) -> Option<bool> {
  match s {
    "1" | "true" | "TRUE" | "yes" | "YES" => Some(true),
    "0" | "false" | "FALSE" | "no" | "NO" => Some(false),
    _ => None,
  }
}

fn parse_kv(args: &[String], key: &str) -> Option<String> {
  let prefix = format!("{key}=");
  for a in args {
    if let Some(rest) = a.strip_prefix(&prefix) {
      return Some(rest.to_string());
    }
  }
  None
}

fn infer_end(frames_dir: &PathBuf) -> Option<usize> {
  let mut max_n: Option<usize> = None;
  let rd = std::fs::read_dir(frames_dir).ok()?;
  for ent in rd.flatten() {
    let name = ent.file_name();
    let name = name.to_string_lossy();
    if !name.starts_with("frame-") {
      continue;
    }
    let Some(num) = name.strip_prefix("frame-") else {
      continue;
    };
    if num.len() != 4 {
      continue;
    }
    if let Ok(n) = num.parse::<usize>() {
      max_n = Some(max_n.map(|m| m.max(n)).unwrap_or(n));
    }
  }
  max_n
}

fn frame_pkg(n: usize) -> String {
  format!("@bad-apple/frame-{:04}", n)
}

fn fmt_dur(d: Duration) -> String {
  let secs = d.as_secs();
  let m = secs / 60;
  let s = secs % 60;
  if m > 0 {
    format!("{m}m{s:02}s")
  } else {
    format!("{s}s")
  }
}

fn main() {
  let argv: Vec<String> = env::args().collect();
  if argv.len() < 2 {
    usage();
  }
  let cmd = argv[1].as_str();
  if cmd != "build" {
    usage();
  }

  let args = &argv[2..];

  let start: usize = parse_kv(args, "--start")
    .and_then(|v| v.parse().ok())
    .unwrap_or(1);

  let silent: bool = parse_kv(args, "--silent")
    .and_then(|v| parse_bool(&v))
    .unwrap_or(true);

  let dry_run: bool = parse_kv(args, "--dry-run")
    .and_then(|v| parse_bool(&v))
    .unwrap_or(false);

  let concurrency: usize = parse_kv(args, "--concurrency")
    .and_then(|v| v.parse().ok())
    .unwrap_or_else(|| {
      let ap = thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
      ap.min(8).max(1)
    });

  let frames_dir = PathBuf::from("apps").join("frames");
  let end: usize = match parse_kv(args, "--end").and_then(|v| v.parse().ok()) {
    Some(v) => v,
    None => infer_end(&frames_dir).unwrap_or(0),
  };

  if end < start || end == 0 {
    eprintln!("invalid frame range: start={start} end={end}");
    std::process::exit(2);
  }

  let total = end - start + 1;
  eprintln!(
    "build frames: start={start} end={end} total={total} concurrency={concurrency} silent={} dry_run={}",
    if silent { 1 } else { 0 },
    if dry_run { 1 } else { 0 }
  );

  let stop = Arc::new(AtomicBool::new(false));
  let done = Arc::new(AtomicUsize::new(0));
  let ok = Arc::new(AtomicUsize::new(0));

  let (task_tx, task_rx) = mpsc::sync_channel::<usize>(concurrency.saturating_mul(2).max(1));
  let task_rx = Arc::new(Mutex::new(task_rx));
  let (res_tx, res_rx) = mpsc::channel::<(usize, bool, String)>();

  for _ in 0..concurrency {
    let task_rx = Arc::clone(&task_rx);
    let res_tx = res_tx.clone();
    let stop = Arc::clone(&stop);

    thread::spawn(move || loop {
      if stop.load(Ordering::Relaxed) {
        break;
      }

      let n = {
        let guard = task_rx.lock().unwrap();
        guard.recv()
      };
      let n = match n {
        Ok(v) => v,
        Err(_) => break,
      };

      if stop.load(Ordering::Relaxed) {
        break;
      }

      let pkg = frame_pkg(n);
      let mut err_tail = String::new();

      let status_ok = if dry_run {
        true
      } else {
        let mut cmd = Command::new("pnpm");
        cmd.arg("--filter").arg(&pkg).arg("build");
        cmd.stdin(Stdio::null());
        if silent {
          cmd.stdout(Stdio::null());
        }
        cmd.stderr(Stdio::piped());

        match cmd.output() {
          Ok(out) => {
            if !out.stderr.is_empty() {
              let s = String::from_utf8_lossy(&out.stderr);
              let keep = 3000usize.min(s.len());
              err_tail = s[s.len().saturating_sub(keep)..].to_string();
            }
            out.status.success()
          }
          Err(e) => {
            err_tail = format!("spawn failed: {e}");
            false
          }
        }
      };

      let _ = res_tx.send((n, status_ok, err_tail));
      if !status_ok {
        stop.store(true, Ordering::Relaxed);
      }
    });
  }
  drop(res_tx);

  // Producer: stop early if any worker flips stop=true.
  thread::spawn({
    let stop = Arc::clone(&stop);
    move || {
      for n in start..=end {
        if stop.load(Ordering::Relaxed) {
          break;
        }
        if task_tx.send(n).is_err() {
          break;
        }
      }
      // dropping sender closes channel -> workers exit.
    }
  });

  let t0 = Instant::now();
  let mut last_print = Instant::now();

  let mut first_fail: Option<(usize, String)> = None;
  while let Ok((n, status_ok, err_tail)) = res_rx.recv() {
    done.fetch_add(1, Ordering::Relaxed);
    if status_ok {
      ok.fetch_add(1, Ordering::Relaxed);
    } else if first_fail.is_none() {
      first_fail = Some((n, err_tail.clone()));
    }

    let d = done.load(Ordering::Relaxed);
    if last_print.elapsed() >= Duration::from_secs(1) || d == total {
      let elapsed = t0.elapsed().as_secs_f64().max(0.0001);
      let rate = d as f64 / elapsed;
      let left = total.saturating_sub(d);
      let eta = if rate > 0.0 {
        Duration::from_secs_f64(left as f64 / rate)
      } else {
        Duration::from_secs(0)
      };
      eprintln!(
        "progress: done={d}/{total} ok={} failed={} rate={:.1}/s eta={}",
        ok.load(Ordering::Relaxed),
        d.saturating_sub(ok.load(Ordering::Relaxed)),
        rate,
        fmt_dur(eta)
      );
      last_print = Instant::now();
    }

    if !status_ok {
      eprintln!("failed: frame-{:04} ({})", n, frame_pkg(n));
      if !err_tail.trim().is_empty() {
        eprintln!("stderr tail:\n{err_tail}");
      }
      break;
    }
  }

  let d = done.load(Ordering::Relaxed);
  let okv = ok.load(Ordering::Relaxed);
  if d == total && okv == total {
    eprintln!("success: built {okv} frames in {}", fmt_dur(t0.elapsed()));
    return;
  }

  if let Some((n, _)) = first_fail {
    eprintln!("exit: build failed at frame-{:04}", n);
  } else {
    eprintln!("exit: build stopped (done={d}/{total} ok={okv})");
  }
  std::process::exit(1);
}
