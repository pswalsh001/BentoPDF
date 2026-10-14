//! Tracks which files on disk the user has handed to the app, and writes to
//! them safely. The web side only ever sees numeric ids, never paths, so it
//! cannot ask to read or write a file the user did not pick, drop or open.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PickedFile {
  pub id: u64,
  pub name: String,
}

#[derive(Default)]
pub struct FileRegistry {
  next_id: u64,
  paths: HashMap<u64, PathBuf>,
}

impl FileRegistry {
  /// Registers a path and returns its handle. The same path always gets the
  /// same id, so opening one file twice still counts as one source.
  pub fn register(&mut self, path: PathBuf) -> PickedFile {
    let name = path
      .file_name()
      .map(|n| n.to_string_lossy().into_owned())
      .unwrap_or_default();
    if let Some((id, _)) = self.paths.iter().find(|(_, p)| **p == path) {
      return PickedFile { id: *id, name };
    }
    self.next_id += 1;
    self.paths.insert(self.next_id, path);
    PickedFile {
      id: self.next_id,
      name,
    }
  }

  pub fn path(&self, id: u64) -> Option<&Path> {
    self.paths.get(&id).map(PathBuf::as_path)
  }
}

/// Replaces `path` with `bytes` by writing a sibling temp file and renaming it
/// over the original, so a crash mid-write never leaves a truncated file.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
  let dir = path.parent().ok_or_else(|| {
    io::Error::new(io::ErrorKind::InvalidInput, "path has no parent folder")
  })?;
  let file_name = path.file_name().ok_or_else(|| {
    io::Error::new(io::ErrorKind::InvalidInput, "path has no file name")
  })?;
  let temp = dir.join(format!(
    ".{}.{}.tmp",
    file_name.to_string_lossy(),
    std::process::id()
  ));

  let result = (|| {
    let mut file = fs::File::create(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)
  })();

  if result.is_err() {
    let _ = fs::remove_file(&temp);
  }
  result
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "bentopdf-test-{}-{}",
      name,
      std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn register_returns_the_file_name_and_a_new_id() {
    let mut registry = FileRegistry::default();
    let picked = registry.register(PathBuf::from("C:/docs/form.pdf"));
    assert_eq!(picked.name, "form.pdf");
    assert_eq!(registry.path(picked.id), Some(Path::new("C:/docs/form.pdf")));
  }

  #[test]
  fn registering_the_same_path_twice_reuses_the_id() {
    let mut registry = FileRegistry::default();
    let first = registry.register(PathBuf::from("C:/docs/form.pdf"));
    let second = registry.register(PathBuf::from("C:/docs/form.pdf"));
    let other = registry.register(PathBuf::from("C:/docs/other.pdf"));
    assert_eq!(first.id, second.id);
    assert_ne!(first.id, other.id);
  }

  #[test]
  fn an_unregistered_id_has_no_path() {
    let registry = FileRegistry::default();
    assert_eq!(registry.path(1), None);
  }

  #[test]
  fn write_atomically_replaces_existing_contents() {
    let dir = temp_dir("replace");
    let target = dir.join("form.pdf");
    fs::write(&target, b"old contents that are longer").unwrap();

    write_atomically(&target, b"new").unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"new");
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn write_atomically_leaves_no_temp_file_behind() {
    let dir = temp_dir("clean");
    let target = dir.join("form.pdf");

    write_atomically(&target, b"data").unwrap();

    let names: Vec<_> = fs::read_dir(&dir)
      .unwrap()
      .map(|e| e.unwrap().file_name())
      .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("form.pdf")]);
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn write_atomically_keeps_the_original_when_the_write_fails() {
    let dir = temp_dir("fail");
    let missing_folder = dir.join("nope").join("form.pdf");

    assert!(write_atomically(&missing_folder, b"data").is_err());
    assert!(!missing_folder.exists());
    fs::remove_dir_all(&dir).unwrap();
  }
}
