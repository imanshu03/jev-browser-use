# Third-party notices

## browser-use/jev-ultrafast

Parts of the fast engine are ported from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast).
Each ported file names the source file in its header comment, and each ported part names it in a comment next to the
code. The ported parts are in these files:

- `src/fast/snapshot.ts` (from `jev_ultrafast/snapshot.js` and `jev_ultrafast/browser.py`)
- `src/fast/page.ts` (from `jev_ultrafast/browser.py`)
- `src/fast/chrome.ts` (from `jev_ultrafast/browser.py`)
- `src/fast/policy.ts` (from `jev_ultrafast/model.py` and `jev_ultrafast/questions.py`)
- `src/fast/loop.ts` (from `jev_ultrafast/agent.py`)
- `src/fast/model.ts` (from the shape of the agent)
- `src/jev.ts` (from `jev_ultrafast/model.py`)
- `src/writer.ts` (from `jev_ultrafast/model.py` field_text and `jev_ultrafast/questions.py` TEXT_VALUE)

The license of that project follows.

```
MIT License

Copyright (c) 2026 Browser Use

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
