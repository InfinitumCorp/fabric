# Third-party notices

FabriC++ uses these packages as npm dependencies (not copied into this repository). The relay serves
their files unchanged to the browser from `node_modules` (`/vendor/noble/...`), apart from rewriting
imports between the packages to those same paths.

## @noble/post-quantum 0.7.1, @noble/hashes 2.4.0, @noble/curves 2.4.0

ML-KEM-768 (FIPS 203) for post-quantum session setup (`shared/pq.js`), and the SHA-3 and helper
code it depends on. https://github.com/paulmillr/noble-post-quantum. License: MIT. None of the three
packages ships a NOTICE file.

- @noble/post-quantum: Copyright (c) 2024 Paul Miller (https://paulmillr.com)
- @noble/hashes: Copyright (c) 2022 Paul Miller (https://paulmillr.com)
- @noble/curves: Copyright (c) 2022 Paul Miller (https://paulmillr.com)

```
The MIT License (MIT)

Copyright (c) 2024 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
