param([switch] $InheritedHandle)
$ErrorActionPreference = 'Stop'
# Looking up Add-Type across a cold module catalog can exhaust the file verification deadline.
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1"
Microsoft.PowerShell.Utility\Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class BatonFileIdentity {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileId {
        public ulong volume, low, high;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder name, uint count, uint flags);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    [DllImport("kernel32.dll")]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out FileId id, uint count);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle file, IntPtr name, uint nameSize,
        IntPtr serial, IntPtr maxComponent, IntPtr flags, StringBuilder fsType, uint fsTypeSize);

    private static string FinalPath(SafeFileHandle file) {
        var name = new StringBuilder(32768);
        uint size = GetFinalPathNameByHandleW(file, name, (uint)name.Capacity, 0);
        return size == 0 || size >= name.Capacity ? null : name.ToString();
    }

    public static string InheritedPath() {
        using (var file = new SafeFileHandle(GetStdHandle(-10 /* STD_INPUT_HANDLE */), false)) {
            return file.IsInvalid ? null : FinalPath(file);
        }
    }

    // A question mark asks Node to verify the original descriptor directly.
    public static string Check(string encoded) {
        var expected = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        using (var stream = new FileStream(expected, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            var file = stream.SafeFileHandle;
            var name = FinalPath(file);
            FileInformation info;
            FileId id;
            if (name == null) return "?";
            if (!String.Equals(name, expected, StringComparison.Ordinal)) return "-";
            var fsType = new StringBuilder(32);
            if (!GetVolumeInformationByHandleW(file, IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, fsType, (uint)fsType.Capacity)
                || !String.Equals(fsType.ToString(), "NTFS", StringComparison.OrdinalIgnoreCase)
                || !GetFileInformationByHandle(file, out info)
                || !GetFileInformationByHandleEx(file, 18 /* FileIdInfo */, out id, (uint)Marshal.SizeOf<FileId>()))
                return "?";
            ulong index = ((ulong)info.indexHigh << 32) | info.indexLow;
            if (index == 0 || id.high != 0 || id.low != index) return "?";
            return info.volume.ToString(System.Globalization.CultureInfo.InvariantCulture) + " "
                + index.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }
}
'@

if ($InheritedHandle) {
    $name = [BatonFileIdentity]::InheritedPath()
    if ([string]::IsNullOrEmpty($name)) { exit 1 }
    $bytes = [Text.Encoding]::UTF8.GetBytes($name)
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    exit 0
}

while ($null -ne ($line = [Console]::ReadLine())) {
    try { [Console]::WriteLine([BatonFileIdentity]::Check($line)) }
    catch { [Console]::WriteLine('?') }
}
