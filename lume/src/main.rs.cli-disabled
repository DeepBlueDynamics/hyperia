use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    
    if args.len() < 2 {
        print_help();
        std::process::exit(0);
    }
    
    let subcommand = args[1].trim().to_lowercase();
    let sub_args: Vec<String> = args.into_iter().skip(2).collect();
    
    match subcommand.as_str() {
        "tag" => {
            lume::cli::tag::run(sub_args);
        }
        "tag-server" => {
            lume::cli::tag_server::run(sub_args);
        }
        "search" => {
            lume::cli::search::run(sub_args);
        }
        "hatcher-boost" | "hatcher" | "boost" => {
            let mut search_args = sub_args;
            search_args.push("--hybrid".to_string());
            lume::cli::search::run(search_args);
        }
        "mcp" => {
            lume::cli::mcp::run(sub_args);
        }
        "crawl" => {
            lume::cli::crawl::run(sub_args);
        }
        "invert" => {
            lume::cli::invert::run(sub_args);
        }
        "-h" | "--help" | "help" => {
            print_help();
        }
        other => {
            eprintln!("\x1B[1;31mError: Unknown subcommand '{}'\x1B[0m", other);
            print_help();
            std::process::exit(1);
        }
    }
}

fn print_help() {
    println!();
    println!("  \x1B[1;35m_      _    _ __  __ ______\x1B[0m");
    println!("  \x1B[1;35m| |    | |  | |  \\/  |  ____|\x1B[0m");
    println!("  \x1B[1;36m| |    | |  | | \\  / | |__\x1B[0m");
    println!("  \x1B[1;36m| |    | |  | | |\\/| |  __|\x1B[0m");
    println!("  \x1B[1;34m| |____| |__| | |  | | |____\x1B[0m");
    println!("  \x1B[1;34m|______|\\____/|_|  |_|______|\x1B[0m  \x1B[1;32mv0.1.0\x1B[0m");
    println!();
    println!(" \x1B[37mHigh-performance, zero-dependency, FST-backed tagger & BM25 hybrid search engine suite.\x1B[0m");
    println!("────────────────────────────────────────────────────────────────────────");
    println!("\x1B[1;33mUSAGE:\x1B[0m");
    println!("  lume \x1B[36m<SUBCOMMAND>\x1B[0m [ARGS...]");
    println!();
    println!("\x1B[1;33mSUBCOMMANDS:\x1B[0m");
    println!("  \x1B[1;32mtag\x1B[0m           Tag text locally using FST dictionary");
    println!("  \x1B[1;32mtag-server\x1B[0m    Run an HTTP tagger server (default port 8282)");
    println!("  \x1B[1;32msearch\x1B[0m        Run BM25 hybrid search REPL or one-shot command");
    println!("  \x1B[1;32mhatcher-boost\x1B[0m HATCHERIK two-stage semantic-lexical boosting engine");
    println!("                \x1B[38;5;244m(Aliases: hatcher, boost)\x1B[0m");
    println!("  \x1B[1;32mmcp\x1B[0m           Run high-performance Model Context Protocol (MCP) server");
    println!("  \x1B[1;32mcrawl\x1B[0m         Crawl a webpage to markdown via grub.nuts.services
  \x1B[1;32minvert\x1B[0m        Invert a neural vector embedding to text w/ optional steered synthesis
");
    println!();
    println!("\x1B[1;33mEXAMPLES:\x1B[0m");
    println!("  \x1B[38;5;244m# Start an interactive hybrid search REPL on Monte Cristo:\x1B[0m");
    println!("  DATA=\"examples/data\" lume search examples/monte_cristo.md");
    println!();
    println!("  \x1B[38;5;244m# Run FST tagging on a custom sentence:\x1B[0m");
    println!("  DATA=\"examples/data\" lume tag \"Edmond Dantès met Valentine in the garden\"");
    println!();
    println!("  \x1B[38;5;244m# Start the high-performance local tagger API server:\x1B[0m");
    println!("  DATA=\"examples/data\" PORT=8282 lume tag-server");
    println!();
    println!("  \x1B[38;5;244m# Run Erik Hatcher's dense HATCHERIK semantic-boost hybrid search REPL:\x1B[0m");
    println!("  DATA=\"examples/data\" lume boost examples/monte_cristo.md");
    println!();
    println!("  \x1B[38;5;244m# Start the high-performance local Model Context Protocol (MCP) server:\x1B[0m");
    println!("  DATA=\"examples/data\" lume mcp");
    println!();
    println!("  \x1B[38;5;244m# Crawl a webpage to your personal search engine collection:\x1B[0m
  lume crawl https://news.ycombinator.com

  \x1B[38;5;244m# Reconstruct a neural vector embedding using premium inversion:\x1B[0m
  NUTS_SERVICES_TOKEN=your_token lume invert dummy examples/monte_cristo.md
──────────────────────────────────────────────────────────────────────────────────────");
    println!();
}
