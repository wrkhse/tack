"""Tests for the Homebrew formula generator."""

import unittest

from homebrew import formula, parse_sums


RELEASE = "0.3.0-rc.1"
TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
)
SUMS = ("a" * 64, "b" * 64, "c" * 64)
NAMES = tuple(f"tack-{RELEASE}-{target}.tar.gz" for target in TARGETS)


def line(name, checksum):
    return f"{checksum}  {name}"


def file(lines):
    return "\n".join(lines) + "\n"


def good_sums():
    return file(line(name, SUMS[i]) for i, name in enumerate(NAMES))


class FormulaTests(unittest.TestCase):
    def test_renders_all_three_urls_and_checksums(self):
        ruby = formula(RELEASE, parse_sums(good_sums()))

        for i, name in enumerate(NAMES):
            self.assertIn(f"/releases/download/v{RELEASE}/{name}", ruby)
            self.assertIn(f'sha256 "{SUMS[i]}"', ruby)

    def test_renders_ruby_interpolation_not_javascript(self):
        ruby = formula(RELEASE, parse_sums(good_sums()))

        self.assertIn('assert_match "tack #{version}"', ruby)
        self.assertIn('shell_output("#{bin}/tack --version")', ruby)
        self.assertNotIn("${version}", ruby)
        self.assertNotIn("${bin}", ruby)

    def test_does_not_declare_version(self):
        ruby = formula(RELEASE, parse_sums(good_sums()))

        for rendered in ruby.splitlines():
            self.assertFalse(rendered.startswith("  version"))

    def test_installs_all_three_binaries(self):
        ruby = formula(RELEASE, parse_sums(good_sums()))

        self.assertIn('bin.install "tack", "tack-daemon", "tack-hook"', ruby)

    def test_rejects_missing_checksum(self):
        text = file(line(name, SUMS[i]) for i, name in enumerate(NAMES[:2]))

        with self.assertRaises(ValueError):
            formula(RELEASE, parse_sums(text))

    def test_rejects_extra_checksum(self):
        lines = [line(name, SUMS[i]) for i, name in enumerate(NAMES)]
        lines.append(line("tack-extra.tar.gz", "d" * 64))

        with self.assertRaises(ValueError):
            formula(RELEASE, parse_sums(file(lines)))

    def test_rejects_duplicate_checksum(self):
        text = file([line(NAMES[0], SUMS[0]), line(NAMES[0], "d" * 64)])

        with self.assertRaises(ValueError):
            formula(RELEASE, parse_sums(text))

    def test_rejects_malformed_version(self):
        with self.assertRaises(ValueError):
            formula("v1.2.3", parse_sums(good_sums()))


class ParseSumsTests(unittest.TestCase):
    def test_rejects_malformed_lines(self):
        with self.assertRaises(ValueError):
            parse_sums("not-a-checksum  tack.tar.gz\n")

        with self.assertRaises(ValueError):
            parse_sums(f'{"a" * 64} tack.tar.gz\n')


if __name__ == "__main__":
    unittest.main()
