# patch-exe-resources.ps1 - de-brand the staged bootstrap launcher.
#
# In the CEF 149 sandbox (bootstrap) model the product exe `holo_cef_host.exe` is the PREBUILT bootstrap.exe
# renamed - so it carries CEF's default icon + version resource, not Hologram's. We can't recompile bootstrap
# (no source), but `holo.rc` already compiles the Hologram icon (ids 1 + 101) and the "Hologram" VERSIONINFO
# into the host DLL. This transplants those already-correct, already-compiled resource blobs from the DLL onto
# the exe using the Win32 resource-update API (the same mechanism rcedit uses), REPLACING the icon + version
# while PRESERVING everything else the bootstrap needs - most importantly its RT_MANIFEST (exec level, DPI).
#
# Safe by construction: BeginUpdateResource works on an in-memory copy and only commits on a clean
# EndUpdateResource; any error discards the update and leaves the exe untouched. Non-fatal - never breaks the
# build (the launcher works regardless of its icon). Idempotent: re-running just re-writes the same blobs.
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File patch-exe-resources.ps1 -SrcPe <host.dll> -DstPe <host.exe>
param(
  [Parameter(Mandatory = $true)][string]$SrcPe,   # source: holo_cef_host.dll (has the Hologram resources)
  [Parameter(Mandatory = $true)][string]$DstPe    # target: holo_cef_host.exe (the staged bootstrap launcher)
)

$ErrorActionPreference = "Stop"
try {
  if (-not (Test-Path $SrcPe)) { Write-Host "patch-exe-resources: src '$SrcPe' missing - skipped"; exit 0 }
  if (-not (Test-Path $DstPe)) { Write-Host "patch-exe-resources: dst '$DstPe' missing - skipped"; exit 0 }

  Add-Type -Namespace Holo -Name PeResx -PassThru -MemberDefinition @"
    const uint LOAD_LIBRARY_AS_DATAFILE = 0x2;
    const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x20;
    public static readonly System.IntPtr RT_ICON       = new System.IntPtr(3);
    public static readonly System.IntPtr RT_GROUP_ICON = new System.IntPtr(14);
    public static readonly System.IntPtr RT_VERSION    = new System.IntPtr(16);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
    static extern System.IntPtr LoadLibraryExW(string f, System.IntPtr h, uint flags);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern bool FreeLibrary(System.IntPtr h);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern System.IntPtr FindResourceW(System.IntPtr h, System.IntPtr name, System.IntPtr type);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern System.IntPtr LoadResource(System.IntPtr h, System.IntPtr res);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern System.IntPtr LockResource(System.IntPtr resData);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern uint SizeofResource(System.IntPtr h, System.IntPtr res);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
    static extern System.IntPtr BeginUpdateResourceW(string pe, bool deleteExisting);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern bool UpdateResourceW(System.IntPtr hUpd, System.IntPtr type, System.IntPtr name, ushort lang, byte[] data, uint cb);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern bool EndUpdateResourceW(System.IntPtr hUpd, bool discard);

    delegate bool EnumLangProc(System.IntPtr h, System.IntPtr type, System.IntPtr name, ushort lang, System.IntPtr param);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    static extern bool EnumResourceLanguagesW(System.IntPtr h, System.IntPtr type, System.IntPtr name, EnumLangProc cb, System.IntPtr param);

    static byte[] Read(System.IntPtr h, System.IntPtr type, System.IntPtr name) {
      System.IntPtr r = FindResourceW(h, name, type);
      if (r == System.IntPtr.Zero) return null;
      uint sz = SizeofResource(h, r);
      System.IntPtr data = LockResource(LoadResource(h, r));
      if (data == System.IntPtr.Zero || sz == 0) return null;
      byte[] b = new byte[sz];
      System.Runtime.InteropServices.Marshal.Copy(data, b, 0, (int)sz);
      return b;
    }

    static System.Collections.Generic.List<ushort> Langs(System.IntPtr h, System.IntPtr type, System.IntPtr name) {
      var langs = new System.Collections.Generic.List<ushort>();
      EnumResourceLanguagesW(h, type, name, (hh, t, n, l, p) => { langs.Add(l); return true; }, System.IntPtr.Zero);
      return langs;
    }

    // Transplant the Hologram icon (group ids 1 + 101, their RT_ICON images) and RT_VERSION (id 1) from src
    // onto dst, replacing any pre-existing copies (across all their languages) and preserving all else.
    public static string Transplant(string srcPe, string dstPe) {
      ushort EN = 1033; // US English, matches holo.rc
      var groupIds = new int[] { 1, 101 };
      var iconIds  = new System.Collections.Generic.HashSet<int>();
      var groupBlobs = new System.Collections.Generic.Dictionary<int, byte[]>();
      var iconBlobs  = new System.Collections.Generic.Dictionary<int, byte[]>();
      byte[] versionBlob = null;
      var dstGroupLangs = new System.Collections.Generic.Dictionary<int, System.Collections.Generic.List<ushort>>();
      var dstVerLangs = new System.Collections.Generic.List<ushort>();
      var dstIconLangs = new System.Collections.Generic.Dictionary<int, System.Collections.Generic.List<ushort>>();

      System.IntPtr src = LoadLibraryExW(srcPe, System.IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
      if (src == System.IntPtr.Zero) return "load src failed (" + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")";
      try {
        foreach (int gid in groupIds) {
          byte[] g = Read(src, RT_GROUP_ICON, new System.IntPtr(gid));
          if (g == null) continue;
          groupBlobs[gid] = g;
          // GRPICONDIR: idCount @4 (WORD); entries @6, 14 bytes each; nID @ entry+12 (WORD).
          int count = System.BitConverter.ToUInt16(g, 4);
          for (int i = 0; i < count; i++) {
            int nID = System.BitConverter.ToUInt16(g, 6 + i * 14 + 12);
            iconIds.Add(nID);
          }
        }
        foreach (int iid in iconIds) {
          byte[] ic = Read(src, RT_ICON, new System.IntPtr(iid));
          if (ic != null) iconBlobs[iid] = ic;
        }
        versionBlob = Read(src, RT_VERSION, new System.IntPtr(1));
      } finally { FreeLibrary(src); }

      if (groupBlobs.Count == 0 && versionBlob == null) return "src has no Hologram icon/version resources";

      // Enumerate existing languages in dst so we can delete stale copies (else a different-language original
      // would survive alongside ours and the shell could still pick it).
      System.IntPtr dstRead = LoadLibraryExW(dstPe, System.IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
      if (dstRead != System.IntPtr.Zero) {
        try {
          foreach (int gid in groupIds) dstGroupLangs[gid] = Langs(dstRead, RT_GROUP_ICON, new System.IntPtr(gid));
          foreach (int iid in iconBlobs.Keys) dstIconLangs[iid] = Langs(dstRead, RT_ICON, new System.IntPtr(iid));
          dstVerLangs = Langs(dstRead, RT_VERSION, new System.IntPtr(1));
        } finally { FreeLibrary(dstRead); }
      }

      System.IntPtr upd = BeginUpdateResourceW(dstPe, false);
      if (upd == System.IntPtr.Zero) return "BeginUpdateResource failed (" + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")";
      try {
        // Delete stale languages, then write ours under en-US.
        foreach (int iid in iconBlobs.Keys) {
          System.Collections.Generic.List<ushort> ls; if (dstIconLangs.TryGetValue(iid, out ls)) foreach (ushort l in ls) UpdateResourceW(upd, RT_ICON, new System.IntPtr(iid), l, null, 0);
          UpdateResourceW(upd, RT_ICON, new System.IntPtr(iid), EN, iconBlobs[iid], (uint)iconBlobs[iid].Length);
        }
        foreach (int gid in groupBlobs.Keys) {
          System.Collections.Generic.List<ushort> ls; if (dstGroupLangs.TryGetValue(gid, out ls)) foreach (ushort l in ls) UpdateResourceW(upd, RT_GROUP_ICON, new System.IntPtr(gid), l, null, 0);
          UpdateResourceW(upd, RT_GROUP_ICON, new System.IntPtr(gid), EN, groupBlobs[gid], (uint)groupBlobs[gid].Length);
        }
        if (versionBlob != null) {
          foreach (ushort l in dstVerLangs) UpdateResourceW(upd, RT_VERSION, new System.IntPtr(1), l, null, 0);
          UpdateResourceW(upd, RT_VERSION, new System.IntPtr(1), EN, versionBlob, (uint)versionBlob.Length);
        }
        if (!EndUpdateResourceW(upd, false)) return "EndUpdateResource failed (" + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + ")";
      } catch (System.Exception ex) { EndUpdateResourceW(upd, true); return "discarded on error: " + ex.Message; }
      return "ok (" + groupBlobs.Count + " group icon(s), " + iconBlobs.Count + " image(s), version=" + (versionBlob != null) + ")";
    }
"@

  $r = [Holo.PeResx]::Transplant((Resolve-Path $SrcPe).Path, (Resolve-Path $DstPe).Path)
  Write-Host "patch-exe-resources: $r"
  exit 0
} catch {
  # Cosmetic step - never fail the build over it.
  Write-Host "patch-exe-resources: non-fatal error - $($_.Exception.Message)"
  exit 0
}
