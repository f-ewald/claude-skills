# Changelog

This file is generated from the repository's first-parent commit history by
[`scripts/update-changelog.mjs`](scripts/update-changelog.mjs). Do not edit it manually.

## 2026-09-02

- Add Swift known issue: Simulator drops debug logs even with log config ([`1ea6d7d`](../../commit/1ea6d7dd3731a2920bc1835b9c4dec19cb45c71c))

## 2026-08-27

- Add widget/extension rules and sensoryFeedback gotcha to Swift standards ([`4edcfb5`](../../commit/4edcfb52c78e5101f82d4339167f99866812bd93))

## 2026-08-18

- Add yamlrocks ([`176f8d0`](../../commit/176f8d0487216296a4d13ef3390096d1449789dc))

## 2026-08-06

- Fix pr-review comment reconciliation and gh pagination ([`2688d9a`](../../commit/2688d9a0dec452bb02765b7be4f42215850f0e46))

## 2026-07-30

- Overhaul prompts, add interview-assessment ([`36fc53d`](../../commit/36fc53d3531e87515988e9fe57da3d01dfac5b62))

## 2026-07-17

- Rename review skill and add generated changelog ([`aa13bfc`](../../commit/aa13bfcf7447946d521904f070c0d45c4817a022))

## 2026-07-16

- Add version-bump fast path to review skill ([`bb5161b`](../../commit/bb5161b350801ceeb898b58c8ea575c27f48779e))

## 2026-07-15

- Overhaul and harden skill portfolio ([`26b3b50`](../../commit/26b3b50dfacfc2f766644051436ed7b1b2ab6ddd))

## 2026-07-14

- Add adversarial red-team phase to deep-research skill ([`21193f2`](../../commit/21193f2ac7b6034fa3b75a2279c4feffce5c25a0))

## 2026-07-13

- Add source-authority and unconfirmed-vs-refuted rigor to deep-research ([`b55acd9`](../../commit/b55acd953782c84a54efee9b0a041efc41667c0b))
- Add heterogeneous model selection to deep-research ([`feca62d`](../../commit/feca62dcc4a91feca2606f19182f9770e6c9d54f))
- Add deep-research skill for autonomous multi-perspective research ([`e067ff5`](../../commit/e067ff51e17c8a267bf542f42bd503950b722de7))
- Change Python indentation standard to 4 spaces ([`3503106`](../../commit/350310690e7c3963689ca09621cfbc2a81cf99f4))

## 2026-07-08

- Add session-lessons skill to mine sessions for durable rules ([`3b95387`](../../commit/3b95387077ccdc8e10eb37cb723b9c2ce85f7c0e))

## 2026-07-07

- Add Swift/SwiftUI programming standards ([`6a07cf9`](../../commit/6a07cf9ecedb1b36acb416b756481a4a3d3bcff4))

## 2026-07-06

- Add gitignore ([`30fbd03`](../../commit/30fbd03d03f52d09567e614049b04ea9ec06f720))

## 2026-07-03

- Require imports at the top of the file in Python standards ([`994f7d8`](../../commit/994f7d8853954334a5b1011a6f0c7358d95094f7))
- Remove LinkedIn attribution from Python standards ([`4aa4fb5`](../../commit/4aa4fb5353b28a0934ca7258e17d9fef758c6dd1))
- Prefer modern union type-hint syntax in Python standards ([`385ebcb`](../../commit/385ebcb1aad4987396fb2743ebae50224dd318a9))
- Add adversarial-review skill ([`149a553`](../../commit/149a5531e0651965bbe010d82d23bb858232e3a5))
- Add ultracode multi-agent orchestration skill ([`8adae70`](../../commit/8adae70f3c75ed915f2960810883ebff9f90a221))
- Add todo and bugs support ([`75c14c6`](../../commit/75c14c678f1f3131f969c17e4e27a1081eb88195))

## 2026-07-01

- Truncate Copilot status-line session name to fit terminal width ([`31d936d`](../../commit/31d936df9244d76720a85a78d76becfe087bd7e7))
- Prefer Ruff and uv for Python tooling ([`a544499`](../../commit/a544499b386a699631eb13ce28e469f8ce14879b))
- Avoid unnecessary dependencies in JavaScript standards ([`7299b2c`](../../commit/7299b2c7e93532f4bb87a2615a54188bffdd3b24))
- Prefer TypeScript for new JavaScript source ([`8214ead`](../../commit/8214ead0e2d58158534357497ede964e5a3627ee))
- Add rule: never create PRs unless explicitly asked (Copilot) ([`1ad4057`](../../commit/1ad405736ec2263ba72668ea0f34cae6b7bfe2b5))
- Add JavaScript programming standards ([`ccdd9e8`](../../commit/ccdd9e8107a971e7922ab85aff42773c019b26b1))
- Document alternate filename for company-managed CLAUDE.md/COPILOT.md ([`aa5acb7`](../../commit/aa5acb7335f182c03cf75391b700b4f0644ad0c0))
- Add programming standards ([`0d1cb80`](../../commit/0d1cb800749b55fb83d1a960c1b64a4d57135db6))
- Global Copilot rules ([`c0714ce`](../../commit/c0714ce14789cebb067f1997cb2dcf89a9b669b2))
- Abbreviate large AIC values with k/m suffix in Copilot status line ([`2218eb2`](../../commit/2218eb2d859bc799b1717154151f0be092a2b2c0))

## 2026-06-30

- Add safety rules for destructive commands to CLAUDE.md ([`5afb451`](../../commit/5afb451d22a545df901cb1a1134c79a8c3b05a41))
- Fix README.md instructions ([`731e3fc`](../../commit/731e3fc884d950282a70e63ea48945f42bc5ae60))
- Add Copilot instructions for the repo ([`63b9e13`](../../commit/63b9e1316a9157e5a489da162850491d763254a6))
- Add current session name to statusline ([`59afcf0`](../../commit/59afcf00298bbae0588069f2b507002767d8500c))
- docs: add bash (Linux) version of directory-scoped copilot function ([`db670d2`](../../commit/db670d2f6be3c6e45d32626ba73486beb97829a2))
- Fix copilot shell function to use sessions-index.json for reliable session resumption ([`2bf3f54`](../../commit/2bf3f5430df7f93dd69976922dc50c7880dcebd9))
- Show AIC used and quota % in Copilot status line ([`6c10ffd`](../../commit/6c10ffddd148d6c37a62cc325e64d6b125996bee))
- Add Copilot CLI status line script ([`703b9d1`](../../commit/703b9d151b46223377ff0b9ce5924d41a3003819))

## 2026-06-17

- Update review skill to be a single review ([`796e678`](../../commit/796e6786c47f86777333d10d37c846d6d90dd831))

## 2026-06-15

- Validate PR description in review skill ([`2e138a9`](../../commit/2e138a9a4bfb8b0c6ddb7dd6089678591b022911))

## 2026-06-14

- Add design-doc skill ([`1050ecc`](../../commit/1050ecc34a7dff865d8753364029b66dea4f3909))
- Copilot migration ([`7ec9ab9`](../../commit/7ec9ab926579650bfafea649fbbda06a58d8196d))
- Improve review skill ([`69e97ef`](../../commit/69e97ef0de71c4845fe62e2ff56bb5bf41531f84))

## 2026-06-11

- Review more polite and professional ([`f083d8e`](../../commit/f083d8eb0d1ae44daa3e87f666068e1379131b55))
- Add review skill ([`8eaac62`](../../commit/8eaac62eb77b94e5c7c82d82ffb0ead98b46a7cc))

## 2026-04-13

- Add statusline ([`89d7922`](../../commit/89d79226f448c5d56f1a486059185414e9a785e5))

## 2026-04-12

- Limit CLAUDE.md size ([`ae8390f`](../../commit/ae8390f02f92b35c1716e0f0eca83f599c5f496b))

## 2026-04-08

- Best practices ([`69a827b`](../../commit/69a827b49def21ae6f7391c73c0c2684a9168777))

## 2026-04-07

- Handle debug statements ([`00d3948`](../../commit/00d3948c38ce627ab62d22482d8e8fb0852e6ac5))

## 2026-03-26

- Added howto ([`8bc319d`](../../commit/8bc319d01df8e371158aecc7d74b391786f5ceb4))
- Update CLAUDE.md on major changes ([`552f300`](../../commit/552f300ebd1c2d6f5369b2a20c1876d9464c619d))

## 2026-03-25

- Avoid big refactors ([`1579f2e`](../../commit/1579f2e131beee0cd42de71b02d28b3bac4b9b27))
- More updated instructions ([`6ad0a46`](../../commit/6ad0a462284eca6952a3fd3dfca6cdb8f105d735))
- Add global CLAUDE.md ([`3167421`](../../commit/3167421d135c27399f7fb8cf50f98bdb82ccaa72))
- Initial commit ([`4f89b9d`](../../commit/4f89b9dab85506ca26ec013c19d757ae2d51045f))
