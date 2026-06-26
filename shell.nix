with import <nixpkgs> {};
mkShell {
  buildInputs = [
    nodejs_24
    #nodePackages.pnpm
    #nodePackages.node2nix
    ruby.gems.redcarpet # for readme generation
  ];
  NODE_ENV = "development";
}
