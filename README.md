# hologram-apps — κ-mirror branch

This branch serves the **content-addressed store** for Hologram OS apps over GitHub Pages:
`https://hologram-technologies.github.io/hologram-apps/b/<blake3-hex>`

Every file is named by the BLAKE3 hash of its bytes. The Q resolver streams app bytes from here
and refuses any byte that does not re-derive to its κ (Law L5). App **source** lives on `main`.
