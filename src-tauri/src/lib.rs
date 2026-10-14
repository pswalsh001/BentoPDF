mod files;

use std::path::PathBuf;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{
  AppHandle, DragDropEvent, Emitter, Manager, State, WebviewUrl,
  WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

use files::{
  launch_file_from_args, write_atomically, FileRegistry, PickedFile,
};

/// The tool a PDF opens in when the app is started with a file.
const LAUNCH_FILE_PAGE: &str = "edit-pdf";

/// Runs before each page's own scripts. A service worker registered by an
/// older build (or by the web version's code) can break a page's entry script
/// when the app starts directly on a tool page, and that script is the only
/// place page code could clean it up from. So it is removed here, followed by
/// one reload to get a page served straight from the app.
const REMOVE_SERVICE_WORKER: &str = r#"
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .getRegistrations()
    .then(function (registrations) {
      if (registrations.length === 0) return;
      return Promise.all(
        registrations.map(function (r) {
          return r.unregister();
        })
      )
        .then(function () {
          return self.caches ? caches.keys() : [];
        })
        .then(function (keys) {
          return Promise.all(
            keys.map(function (key) {
              return caches.delete(key);
            })
          );
        })
        .then(function () {
          if (sessionStorage.getItem('sw-cleanup-reloaded')) return;
          sessionStorage.setItem('sw-cleanup-reloaded', '1');
          location.reload();
        });
    })
    .catch(function () {});
})();
"#;

struct Registry(Mutex<FileRegistry>);

/// The file the app was started with, until the page collects it.
struct LaunchFile(Mutex<Option<PickedFile>>);

#[derive(Clone, Serialize)]
struct DroppedFiles {
  files: Vec<PickedFile>,
  x: f64,
  y: f64,
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
  request.headers().get(name).and_then(|v| v.to_str().ok())
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(bytes),
    _ => Err("expected the file contents as a raw body".into()),
  }
}

fn registered_path(
  registry: &State<'_, Registry>,
  id: u64,
) -> Result<PathBuf, String> {
  registry
    .0
    .lock()
    .unwrap()
    .path(id)
    .map(PathBuf::from)
    .ok_or_else(|| "that file was not opened in this session".to_string())
}

/// Shows the native Open dialog and returns handles for the chosen files.
#[tauri::command]
async fn pick_files(
  app: AppHandle,
  registry: State<'_, Registry>,
  multiple: bool,
  extensions: Vec<String>,
) -> Result<Vec<PickedFile>, String> {
  let mut dialog = app.dialog().file();
  if !extensions.is_empty() {
    let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
    dialog = dialog.add_filter("Supported files", &extensions);
  }

  let chosen = if multiple {
    dialog.blocking_pick_files().unwrap_or_default()
  } else {
    dialog.blocking_pick_file().into_iter().collect()
  };

  let mut registry = registry.0.lock().unwrap();
  Ok(
    chosen
      .into_iter()
      .filter_map(|file| file.into_path().ok())
      .map(|path| registry.register(path))
      .collect(),
  )
}

/// The file the app was started with, if the page has not opened it yet.
#[tauri::command]
fn launch_file(launch: State<'_, LaunchFile>) -> Option<PickedFile> {
  launch.0.lock().unwrap().clone()
}

/// Called by the page once the launch file is loaded, so that returning to
/// the editor later does not open it a second time.
#[tauri::command]
fn launch_file_opened(launch: State<'_, LaunchFile>) {
  launch.0.lock().unwrap().take();
}

#[tauri::command]
async fn read_file(
  registry: State<'_, Registry>,
  id: u64,
) -> Result<Response, String> {
  let path = registered_path(&registry, id)?;
  std::fs::read(&path)
    .map(Response::new)
    .map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Replaces a file the user opened this session. Body: the new contents.
/// Header `x-file-id`: the handle from `pick_files` or a drop.
#[tauri::command]
async fn overwrite_file(
  request: Request<'_>,
  registry: State<'_, Registry>,
) -> Result<(), String> {
  let id = header(&request, "x-file-id")
    .and_then(|v| v.parse::<u64>().ok())
    .ok_or("missing x-file-id header")?;
  let path = registered_path(&registry, id)?;
  write_atomically(&path, raw_body(&request)?)
    .map_err(|e| format!("could not save {}: {e}", path.display()))
}

/// Shows the native Save dialog and writes the body there. Returns the saved
/// file's name, or `None` if the dialog was cancelled.
/// Headers: `x-suggested-name` (percent-encoded), optional `x-near-file-id`
/// to start the dialog in that file's folder.
#[tauri::command]
async fn save_file_as(
  app: AppHandle,
  request: Request<'_>,
  registry: State<'_, Registry>,
) -> Result<Option<String>, String> {
  let suggested = header(&request, "x-suggested-name")
    .map(|v| percent_decode_str(v).decode_utf8_lossy().into_owned())
    .unwrap_or_else(|| "document.pdf".into());
  let near = header(&request, "x-near-file-id")
    .and_then(|v| v.parse::<u64>().ok())
    .and_then(|id| registered_path(&registry, id).ok());

  let mut dialog = app.dialog().file().set_file_name(&suggested);
  if let Some(folder) = near.as_deref().and_then(|p| p.parent()) {
    dialog = dialog.set_directory(folder);
  }
  if let Some(ext) = PathBuf::from(&suggested)
    .extension()
    .and_then(|e| e.to_str())
  {
    dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
  }

  let Some(path) = dialog.blocking_save_file().and_then(|f| f.into_path().ok())
  else {
    return Ok(None);
  };
  write_atomically(&path, raw_body(&request)?)
    .map_err(|e| format!("could not save {}: {e}", path.display()))?;
  Ok(Some(registry.0.lock().unwrap().register(path).name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(Registry(Mutex::new(FileRegistry::default())))
    .manage(LaunchFile(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![
      pick_files,
      launch_file,
      launch_file_opened,
      read_file,
      overwrite_file,
      save_file_as
    ])
    .on_window_event(|window, event| {
      // Files dropped on the window arrive here with their real paths; the
      // page is told only their handles and where they landed.
      if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) =
        event
      {
        let registry = window.state::<Registry>();
        let files: Vec<PickedFile> = {
          let mut registry = registry.0.lock().unwrap();
          paths
            .iter()
            .filter(|p| p.is_file())
            .map(|p| registry.register(p.clone()))
            .collect()
        };
        if !files.is_empty() {
          let _ = window.emit(
            "desktop-files-dropped",
            DroppedFiles {
              files,
              x: position.x,
              y: position.y,
            },
          );
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Started with a PDF (double-click or "Open with"): go straight to
      // the editor, which collects the file through `launch_file`.
      let launch_path = launch_file_from_args(std::env::args().skip(1));
      let mut window = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json defines no window")?;
      if let Some(path) = launch_path {
        let picked = app.state::<Registry>().0.lock().unwrap().register(path);
        *app.state::<LaunchFile>().0.lock().unwrap() = Some(picked);
        window.url = WebviewUrl::App(LAUNCH_FILE_PAGE.into());
      }
      WebviewWindowBuilder::from_config(app.handle(), &window)?
        .initialization_script(REMOVE_SERVICE_WORKER)
        .build()?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
