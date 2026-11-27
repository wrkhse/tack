import test from "node:test"
import assert from "node:assert/strict"
import { formula, parseSums } from "./homebrew.mjs"

const RELEASE = "0.3.0-rc.1"
const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
]
const SUMS = ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
const NAMES = TARGETS.map((target) => `tack-${RELEASE}-${target}.tar.gz`)

const line = (name, sum) => `${sum}  ${name}`
const file = (lines) => `${lines.join("\n")}\n`
const goodSums = () => file(NAMES.map((name, i) => line(name, SUMS[i])))

test("renders all three release URLs and checksums", () => {
  const ruby = formula(RELEASE, parseSums(goodSums()))

  for (let i = 0; i < NAMES.length; i += 1) {
    assert.ok(ruby.includes(`/releases/download/v${RELEASE}/${NAMES[i]}`))
    assert.ok(ruby.includes(`sha256 "${SUMS[i]}"`))
  }

  assert.ok(ruby.includes('assert_match "tack ${version}", shell_output("#{bin}/tack --version")'))
})

test("rejects a missing checksum", () => {
  const text = file(NAMES.slice(0, 2).map((name, i) => line(name, SUMS[i])))

  assert.throws(() => formula(RELEASE, parseSums(text)))
})

test("rejects an extra checksum", () => {
  const text = file([
    ...NAMES.map((name, i) => line(name, SUMS[i])),
    line("tack-extra.tar.gz", "d".repeat(64)),
  ])

  assert.throws(() => formula(RELEASE, parseSums(text)))
})

test("rejects a duplicate checksum line", () => {
  const text = file([line(NAMES[0], SUMS[0]), line(NAMES[0], "d".repeat(64))])

  assert.throws(() => formula(RELEASE, parseSums(text)))
})

test("rejects a malformed version", () => {
  assert.throws(() => formula("v1.2.3", parseSums(goodSums())))
})

test("parseSums rejects a malformed line", () => {
  assert.throws(() => parseSums("not-a-checksum  tack.tar.gz\n"))
  assert.throws(() => parseSums("a".repeat(64) + " tack.tar.gz\n"))
})
