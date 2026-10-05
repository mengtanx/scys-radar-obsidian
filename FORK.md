# 个人分支

社区版和这份同时装。社区版 id 是 `scys-radar`，这份是 `scys-radar-mx`。

- `upstream`：`zackzhangkai/scys-radar-obsidian`。`main` 只快进它，不在 `main` 上改功能。
- `origin`：`mengtanx/scys-radar-obsidian`。开发在 `dev`。
- 授权端口：社区版 `17419`，这份 `17420`。两份都要各自登录一次。
- 样式类名仍是 `.scys-*`。改 `styles.css` 会同时作用到社区版。

## 合入上游的一个 release

```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git checkout dev
git merge main
```

冲突留在 `dev` 上解决。`manifest.json` 的 id、名字、版本留这份自己的。合完后把 `manifest.json` 的 version 往上加一档，`versions.json` 加同一行，再发 Release。

## 让 BRAT 看到新版本

BRAT 读 GitHub Release，不读未发布的提交。Release 要带上 `main.js`、`manifest.json`、`styles.css`，tag 用 manifest 里的 version。

```bash
git push origin main dev
gh release create 0.3.1 main.js manifest.json styles.css --target dev --title "0.3.1" --notes "合入上游后的个人版本"
```

ShengCai 里 BRAT 跟踪 `mengtanx/scys-radar-obsidian`。启动时它会把更新写进 `.obsidian/plugins/scys-radar-mx/`。
