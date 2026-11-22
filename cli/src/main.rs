//! The tack command-line entry point.

fn main() {
    println!("tack {}", env!("CARGO_PKG_VERSION"));
}
