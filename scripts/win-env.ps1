# Puts Node 22 on PATH for this shell.
#
# Photoshop runs on Windows, so the whole stack runs here too; the machine-wide
# Node is older than the toolchain needs (vitest imports 's
# , which is Node 22+), so sessions started outside a new logon pin
# the local build explicitly rather than depending on the user PATH having been
# picked up.
 = 'C:\Users\maksim\.local\node\node-v22.23.3-win-x64'
if (Test-Path ) { :Path =  + ';' + :Path }
