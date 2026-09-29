# halo-hub

Installable add-ons for [Halo](https://github.com/turmind/halo-agent), kept out of the main app so the core package stays small.

## Layout

```
extensions/<id>/    Canvas preview extensions (open file types the core app does not ship, e.g. .drawio, .glb)
skills/<id>/        Skills (SKILL.md + resources)
workspaces/<id>/    Shareable workspace bundles (.halo/ config)
dist/               Build output — packaged zips, not committed
```

- One directory per item. The directory name is the item's id.
- Each item is packaged as a standalone zip. Zips are published as GitHub release assets, not committed to the repo.

## Install

Extensions install globally (under `~/.halo/global/`) from a zip. The manifest format and install flow are being designed in the main repo; details will land here with the first extension.
