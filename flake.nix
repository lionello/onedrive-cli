{
  description = "OneDrive command line interface";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        onedrive-cli = pkgs.buildNpmPackage {
          pname = "onedrive-cli";
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = ./.;

          # Update after changing package-lock.json:
          #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-8H3RMoLsPJrWWgAXj9u3BiCUToEHsLWAFn+OIjyW3s4=";

          # Pure-JS CLI: no build step, just install deps and link the bin.
          dontNpmBuild = true;

          meta = {
            description = "OneDrive command line interface";
            homepage = "https://github.com/lionello/onedrive-cli";
            license = nixpkgs.lib.licenses.mit;
            mainProgram = "onedrive-cli";
          };
        };
      in
      {
        packages.default = onedrive-cli;
        packages.onedrive-cli = onedrive-cli;

        apps.default = flake-utils.lib.mkApp { drv = onedrive-cli; };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.ruby.gems.redcarpet # for readme generation
          ];
          NODE_ENV = "development";
        };
      });
}
