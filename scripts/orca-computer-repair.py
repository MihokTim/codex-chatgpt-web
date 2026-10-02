"""Version-scoped Windows screenshot correction for Orca 1.4.215.

Stage before apply; never stop/restart apps or change Windows focus restrictions.
The provider reloads its script after its normal idle shutdown.
"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def patch_hotkey(source):
    before = '    $key = $parts[$parts.Count - 1]\n    $prefix = ""'
    after = ('    $key = $parts[$parts.Count - 1]\n'
             '    # SendKeys treats uppercase letters as Shift+letter. A hotkey key\n'
             '    # name identifies a physical key; Shift must be explicit.\n'
             '    if ($key -cmatch "^[A-Z]$") { $key = $key.ToLowerInvariant() }\n'
             '    $prefix = ""')
    if source.count(before) != 1:
        raise ValueError('Unknown runtime; hotkey anchor mismatch')
    return source.replace(before, after, 1)


def patch(source):
    changes = [
        ('function Get-OrcaScreenshot([bool]$IncludeScreenshot, $WindowFrame) {',
         'function Get-OrcaScreenshot([bool]$IncludeScreenshot, $WindowFrame, [IntPtr]$WindowHandle) {'),
        ('    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }\n    $bitmap = $null',
         '    if (-not $IncludeScreenshot -or $null -eq $WindowFrame) { return $null }\n'
         '    # CopyFromScreen captures the visible desktop, not the HWND surface.\n'
         '    # Never label a foreground app image as this background window.\n'
         '    if (-not (Test-OrcaWindowFocused $WindowHandle)) {\n'
         '        return New-OrcaScreenshotFocusError\n'
         '    }\n    $bitmap = $null'),
        ('        Get-OrcaBoundedScreenshotPayload $bitmap\n    } catch {',
         '        if (-not (Test-OrcaWindowFocused $WindowHandle)) {\n'
         '            return New-OrcaScreenshotFocusError\n'
         '        }\n        Get-OrcaBoundedScreenshotPayload $bitmap\n    } catch {'),
        ('    if ($RestoreWindow) { Restore-OrcaWindow $process }\n    Assert-OrcaWindowTarget',
         '    if ($RestoreWindow) {\n        Restore-OrcaWindow $process\n'
         '        [void](Wait-OrcaWindowFocused ([IntPtr]$process.MainWindowHandle) 500)\n'
         '    }\n    Assert-OrcaWindowTarget'),
        ('    $screenshot = Get-OrcaScreenshot $IncludeScreenshot $windowFrame',
         '    $screenshot = Get-OrcaScreenshot $IncludeScreenshot $windowFrame ([IntPtr]$process.MainWindowHandle)'),
    ]
    if 'function New-OrcaScreenshotFocusError' in source:
        raise ValueError('Already patched; refuse a second patch')
    for before, after in changes:
        if source.count(before) != 1:
            raise ValueError('Unknown runtime; screenshot anchor mismatch')
        source = source.replace(before, after, 1)
    marker = 'function Get-OrcaScreenshot('
    function = '''function New-OrcaScreenshotFocusError {
    [pscustomobject]@{
        base64 = $null; width = $null; height = $null; scale = $null
        error = [pscustomobject]@{
            message = "Target window is not foreground; desktop capture would contain another app. Use --no-screenshot for accessibility inspection, or --restore-window once. If restoration fails, bring the window forward manually."
        }
    }
}

'''
    return patch_hotkey(source.replace(marker, function + marker, 1))


def stage(runtime, directory):
    original = runtime.read_bytes()
    original_hash = digest(original)
    if original_hash not in ('104d551f4d423c619eed22e65f0e6f74b37a104de01dadc49ce0b7844f32597c',
                             'b152ea8853f0cea9d731c8745d4fd802860df151edf4ae9b20b8c54deac8f169'):
        raise ValueError('Only the verified Orca 1.4.215 Windows runtime is supported')
    source = original.decode('utf-8-sig').replace('\r\n', '\n')
    # Preserve original BOM and line endings; only the guarded replacements differ.
    candidate = patch(source) if original_hash.startswith('104d551f') else patch_hotkey(source)
    if b'\r\n' in original:
        candidate = candidate.replace('\n', '\r\n')
    patched = candidate.encode('utf-8-sig' if original.startswith(b'\xef\xbb\xbf') else 'utf-8')
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'runtime.original.ps1').write_bytes(original)
    (directory / 'runtime.patched.ps1').write_bytes(patched)
    manifest = {'version': '1.4.215', 'source': str(runtime.resolve()), 'originalSha256': digest(original),
                'patchedSha256': digest(patched), 'applied': False}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


def apply(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    target = Path(manifest['source'])
    candidate = (manifest_path.parent / 'runtime.patched.ps1').read_bytes()
    if digest(target.read_bytes()) != manifest['originalSha256'] or digest(candidate) != manifest['patchedSha256']:
        raise ValueError('Runtime or staged evidence changed; refusing apply')
    temp = target.with_suffix('.repair.tmp')
    with temp.open('xb') as file:
        file.write(candidate)
    temp.replace(target)
    if digest(target.read_bytes()) != manifest['patchedSha256']:
        raise ValueError('Post-deployment hash mismatch')
    manifest['applied'] = True
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('stage', 'apply'))
    parser.add_argument('path', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.mode == 'stage' and args.output is None:
        parser.error('stage requires --output')
    print(json.dumps(stage(args.path.resolve(), args.output.resolve()) if args.mode == 'stage'
                     else apply(args.path.resolve()), indent=2))
