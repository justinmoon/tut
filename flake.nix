{
  description = "tut - lightweight code-change tutorial generator";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: let
    systems = [ "aarch64-darwin" ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = self.packages.${system}.tut;
      tut = pkgs.stdenvNoCC.mkDerivation {
        pname = "tut";
        version = "0.1.3";
        src = ./dist/tut-aarch64-darwin.gz;
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.gzip ];
        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          gzip -dc "$src" > "$out/bin/tut"
          chmod +x "$out/bin/tut"
          runHook postInstall
        '';
        meta = {
          description = "Generate and browse code-change tutorials for Hunk reviews";
          mainProgram = "tut";
        };
      };
    });
  };
}
