{
  description = "k6 load test dev environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { utils, nixpkgs, ... }:
    utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        pythonEnv = pkgs.python3.withPackages (ps: [ ps.jinja2 ps.pyyaml ]);
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            basedpyright
            just
            kubectl
            prettier
            pythonEnv
            ruff
            typescript
            (google-cloud-sdk.withExtraComponents (
              with google-cloud-sdk.components; [ gke-gcloud-auth-plugin ]
            ))
          ];

          shellHook =
            let
              pythonPlatform = if pkgs.stdenv.isDarwin then "Darwin" else "Linux";
            in
            ''
              cat > scripts/pyrightconfig.json <<EOF
              {
                "pythonVersion": "${pkgs.python3.pythonVersion}",
                "pythonPlatform": "${pythonPlatform}",
                "pythonPath": "${pythonEnv}/bin/python${pkgs.python3.pythonVersion}",
                "typeCheckingMode": "recommended",
                "reportMissingModuleSource": "none"
              }
              EOF
            '';
        };
      }
    );
}
