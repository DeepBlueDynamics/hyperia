fn main() {
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set("CompanyName", "DeepBlue Dynamics LLC")
            .set("FileDescription", "Hyperia sidecar — agent engine, MCP, signaling")
            .set("ProductName", "Hyperia")
            .set("LegalCopyright", "© DeepBlue Dynamics LLC");
        res.compile().unwrap();
    }
}
