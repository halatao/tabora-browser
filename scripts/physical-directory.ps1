function Resolve-TaboraPhysicalDirectory([string]$Directory) {
  # Node realpath does not reveal MSIX AppData redirection. Resolve the OS handle.
  if (-not ('Tabora.PhysicalDirectory' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Tabora {
 public static class PhysicalDirectory {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
  public static string Resolve(string directory) {
   using(var handle=CreateFile(directory,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
    if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
    var path=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(handle,path,(uint)path.Capacity,0);
    if(size==0)throw new Win32Exception(Marshal.GetLastWin32Error());
    if(size>=path.Capacity)throw new Exception("State directory path is too long.");
    string result=path.ToString();
    if(result.StartsWith(@"\\?\UNC\"))return @"\\"+result.Substring(8);
    if(result.StartsWith(@"\\?\"))return result.Substring(4);
    return result;
   }
  }
 }
}
'@
  }
  return [Tabora.PhysicalDirectory]::Resolve($Directory)
}
