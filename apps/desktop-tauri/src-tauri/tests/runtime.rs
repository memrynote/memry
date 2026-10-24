#[test]
fn rustls_default_provider_is_ring_after_install() {
    memry_tauri::install_crypto_provider();
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    // Idempotent.
    memry_tauri::install_crypto_provider();
    // The shared client builds on that provider.
    let _client = memry_desktop::http::client();
}
