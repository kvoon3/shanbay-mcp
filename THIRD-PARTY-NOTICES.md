# Third-party notices

This project is MIT licensed (see [LICENSE](LICENSE)). It builds on the
following work.

## honwhy/shanbay-ext — MIT

- Source: https://github.com/honwhy/shanbay-ext
- Used for: `src/decode.ts`, a TypeScript port of
  `src/entrypoints/decodes.js` (the "bayDecode" scheme used by Shanbay's web
  client). The `encode()` helper is the port of the `encode()` that upstream
  ships commented out.
- Changes made in this port: garbage input throws instead of looping forever;
  base64 decoding is strict instead of relying on Node's lenient `Buffer`;
  a payload that is not encoded throws instead of returning `""`.

```
MIT License

Copyright (c) 2024 Honwhy Wang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3b391433/shanbay-cli — no license, no code taken

- Source: https://github.com/3b391433/shanbay-cli
- Used for: prior art and a pointer to the private apiv3 surface. Reading it is
  what showed that the word-collection endpoints were the missing piece.

That repository does not carry a license, so **no code from it is reproduced
here**. In particular `src/decode.ts` was written against the MIT-licensed
JavaScript in honwhy/shanbay-ext (the upstream that shanbay-cli's Go port itself
credits), and the endpoint table in the README was recovered from Shanbay's own
public web client.

## Shanbay

Not affiliated with, endorsed by, or supported by 扇贝 (Shanbay). The endpoints
are private and undocumented; they may change or disappear at any time. No
Shanbay content (dictionary entries, example sentences, audio) is distributed
with this repository — `scripts/capture-fixture.ts` fetches fixtures into a
gitignored `testdata/` directory on your own machine, under your own account.
