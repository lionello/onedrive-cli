with import <nixpkgs> {};
mkShell {
  buildInputs = [
    nodejs-10_x
    nodePackages_10_x.pnpm
  ];
}
