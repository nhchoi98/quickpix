#[cfg(feature = "console_error_panic_hook")]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

#[cfg(not(feature = "console_error_panic_hook"))]
pub fn set_panic_hook() {}

pub fn to_css_filter(filter: &str) -> u32 {
    match filter.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "nearest" => 0,
        "bilinear" => 1,
        "box" => 2,
        "hamming" => 3,
        "lanczos" | "lanczos3" => 4,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::to_css_filter;

    #[test]
    fn default_filter_to_bilinear() {
        assert_eq!(to_css_filter("unknown"), 1);
        assert_eq!(to_css_filter("nearest"), 0);
        assert_eq!(to_css_filter("bilinear"), 1);
        assert_eq!(to_css_filter("box"), 2);
        assert_eq!(to_css_filter("hamming"), 3);
        assert_eq!(to_css_filter("lanczos"), 4);
        assert_eq!(to_css_filter("lanczos3"), 4);
    }
}
