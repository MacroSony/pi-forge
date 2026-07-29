import { EDITOR_CLIENT_SCRIPT } from "./client-script.js";
import { EDITOR_CLIENT_STYLES } from "./client-styles.js";
import { EDITOR_STYLES } from "./styles.js";
export function renderEditorHtml() {
    return String.raw `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>pi-forge stack editor</title>
<style>${inlineStyle(`${EDITOR_STYLES}\n${EDITOR_CLIENT_STYLES}`)}</style>
</head>
<body>
<div id="app"></div>
<script>${inlineScript(EDITOR_CLIENT_SCRIPT)}</script>
</body>
</html>`;
}
export function inlineScript(source) {
    return source.replace(/<\/script/gi, "<\\/script");
}
export function inlineStyle(source) {
    return source.replace(/<\/style/gi, "<\\/style");
}
//# sourceMappingURL=page.js.map