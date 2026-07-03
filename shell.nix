# Dev shell definition, shared by `nix-shell` (which calls this directly with
# the channel's nixpkgs) and the flake's devShell (which imports it with the
# flake's pinned nixpkgs). Single source of truth for dev dependencies.
{
  pkgs ? import <nixpkgs> { },
}:
pkgs.mkShell {
  packages = [
    pkgs.nixfmt
    pkgs.nodejs_24
    pkgs.ruby.gems.redcarpet # for readme generation
  ];
  NODE_ENV = "development";
}
