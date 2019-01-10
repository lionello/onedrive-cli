with import <nixpkgs> {};
let
  pnpmPkg = nodePackages_10_x.pnpm;
  # npm ERR! Unsupported URL Type "link:": link:../../privatePackages/assert-project
  pnpm = (pnpmPkg.override (old: {
      preRebuild = ''
        sed -i 's|link:|file:|' package.json
      '';
  }));
in mkShell {
  buildInputs = [
    nodejs-slim-8_x
    pnpm
  ];
}
