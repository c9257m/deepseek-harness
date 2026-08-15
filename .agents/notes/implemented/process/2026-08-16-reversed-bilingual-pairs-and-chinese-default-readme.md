# Agent Note: Reversed bilingual pairs and the Chinese-default root README

Status: implemented

English | [中文](2026-08-16-reversed-bilingual-pairs-and-chinese-default-readme.zh.md)

## Problem

The bilingual pairing contract names the unsuffixed `foo.md` as the English side and `foo.zh.md` as the Chinese side of every pair, so the root README's default-displayed document is English. The product's primary audience and community channel are Chinese, and the packaged desktop installer (see the [desktop shell note](../feature/2026-08-15-desktop-electron-shell.md)) targets a Chinese-first install experience; readers who land on the repository or the installer see an English front page first.

## Decision

The root README pair is reversed: `README.md` is the Simplified Chinese side (the default-displayed document on GitHub, npm, and every other renderer) and the English side carries the `README.en.md` suffix; `README.zh.md` is deleted. Reversed pairs are a general contract feature, declared by stem in `REVERSED_PAIR_STEMS` in [scripts/translation-pairing-record.ts](../../../../scripts/translation-pairing-record.ts); the root README is the first reversed pair. The pairing gate, merge driver, translation brief generator, translation prompt, and record tooling resolve reversed pairs by stem; every other rule — the three-file triplet, the consistency record, the switcher (the Chinese side links back to the English file), and the structural signature — applies unchanged.

The desktop install path is documented in the root README's new 桌面应用 / Desktop app section, and the desktop package's own README and its Agent Note ship their missing Chinese counterparts so the corpus returns to a green state. The root README keeps the structure and voice established by the [product-first note](2026-07-22-product-first-root-readme.md).

## Alternatives considered

**Keep the English-default pair and rely on README.zh.md.** The `.zh.md` side never renders by default on GitHub or npm, so the default display would stay English; only the pair's own switcher would be discoverable.

**Exclude the root README from pairing.** The contract states there is no README-specific policy class; an exclusion would leave the most visible document unpaired and weaken the bilingual guarantee.

**Auto-detect orientation from the files on disk.** Implicit detection would silently reinterpret an existing `foo.md` + `foo.zh.md` pair when a stray `foo.en.md` appears; explicit stems keep orientation a reviewed declaration.

## Consequences

GitHub, npm, and the packaged installer's landing surfaces show Chinese first; English readers switch via the `README.en.md` link. Docs that link into the root README target `README.md` with the Chinese heading anchors (运行 / 从源码运行), keeping the `.md`-path link convention. A future reversed pair adds its stem to `REVERSED_PAIR_STEMS`; the tooling needs no further change. `README.zh.md` is gone from history going forward, so cross-links to it must move to `README.en.md` or `README.md` depending on the intended language.
