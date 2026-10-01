# 第三方组件与许可

Mesa 本体按 [MIT](../../LICENSE) 发布。安装包与源码中再分发的第三方组件如下。
完整依赖树以锁文件为准（`package-lock.json`、`src-tauri/Cargo.lock`）；本清单只列直接依赖与内嵌资产。

## 内嵌资产

### JetBrains Mono（OFL 1.1）

- 用途：终端与代码等宽字体（`src/assets/fonts/JetBrainsMono-{400,500,700}.woff2`）
- 版权：© JetBrains Ltd.，主页 <https://www.jetbrains.com/lp/mono/>
- 许可：SIL Open Font License 1.1，全文如下

---

```
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may include
source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer
or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.
```

## 主要依赖

| 组件 | 用途 | 许可 |
|---|---|---|
| Tauri v2（含各官方插件） | 应用框架 | MIT / Apache-2.0 |
| React、react-dom | UI 框架 | MIT |
| zustand | 状态管理 | MIT |
| @xterm/xterm 及 addons | 内嵌终端 | MIT |
| monaco-editor | 代码编辑器 | MIT |
| katex | 公式渲染 | MIT |
| marked、dompurify | Markdown 渲染与净化 | MIT / (Apache-2.0 或 MPL-2.0) |
| mermaid | 图表渲染 | MIT |
| lucide-react | 图标 | ISC |
| mammoth | .docx 读取 | BSD-2-Clause |
| pdfjs-dist | PDF 渲染 | Apache-2.0 |
| tailwindcss、vite、esbuild、typescript | 构建链 | MIT |
| 各 AI CLI（Claude Code、Codex 等） | Mesa 只做拉起与配置，不捆绑其本体 | 各自协议，与本项目无关 |
