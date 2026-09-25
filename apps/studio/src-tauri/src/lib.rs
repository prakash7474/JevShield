use serde::Serialize;

#[derive(Serialize)]
pub struct ShellInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub runtime: &'static str,
}

/// Smoke-test command proving the webview ↔ Rust bridge works.
///
/// Live Jev and Gemini calls currently run in the webview. If you need to
/// bypass browser CORS rules, move them behind commands here and hand the
/// frontend a `fetch` implementation via `JevShield`'s `httpClient` option.
#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        name: "JevShield Studio",
        version: env!("CARGO_PKG_VERSION"),
        runtime: "tauri-v2",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("failed to start the JevShield Studio shell");
}
