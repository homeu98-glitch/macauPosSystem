#!/bin/sh
# 由 GCM 取真實憑證，經內聯 helper 餵給 push（README 記錄 GCM 會偶發掛住）
export PATH="/c/Users/surface/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/c/Users/surface/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:$PATH"

CRED=$(printf "protocol=https\nhost=github.com\n\n" | GCM_INTERACTIVE=never /c/Users/surface/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git-credential-manager.exe get)
USER=$(printf '%s\n' "$CRED" | sed -n 's/^username=//p')
PASS=$(printf '%s\n' "$CRED" | sed -n 's/^password=//p')

cat > /tmp/cred_helper.sh <<EOF
#!/bin/sh
printf 'username=$USER\npassword=$PASS\n'
EOF
chmod +x /tmp/cred_helper.sh

cd "C:/dev/macauPos/macauPosSystem" || exit 1
C:/Users/surface/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe \
  -c credential.helper= \
  -c "credential.helper=/tmp/cred_helper.sh" \
  push origin main
