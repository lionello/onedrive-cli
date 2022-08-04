with import <nixpkgs> {};
mkShell {
  buildInputs = [
    nodejs-14_x
    nodePackages.pnpm
    ruby.gems.redcarpet # for readme generation
    nodePackages.node2nix
  ];
  NODE_ENV = "development";
}
