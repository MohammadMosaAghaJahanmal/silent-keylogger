# Test harness only. If the desktop has UAC disabled, ShellExecute inherits an
# administrator token. Run the verification with administrators disabled and
# privileges removed at medium integrity, on a private test desktop, without
# changing account settings or the interactive desktop's permissions.
param([switch]$LeaveInstalled)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PDFStandardUser {
    [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int cb; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title;
        public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort show, reservedSize; public IntPtr reservedData, stdin,stdout,stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSidW(string str,out IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string str,uint revision,out IntPtr descriptor,out uint length);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint count,[In] SidAttributes[] disable,uint privilegeCount,IntPtr privileges,uint restrictedCount,IntPtr restricted,out IntPtr result);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref SidAttributes data,uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,ref IntPtr data,uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr acl,out bool defaulted);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStationW(string name,uint flags,uint access,ref Security security);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,string device,IntPtr mode,uint flags,uint access,ref Security security);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
    static void Require(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static uint Run(string script,string directory,bool leaveInstalled) {
        IntPtr token=IntPtr.Zero,restricted=IntPtr.Zero,admin=IntPtr.Zero,medium=IntPtr.Zero,descriptor=IntPtr.Zero,station=IntPtr.Zero,desktop=IntPtr.Zero;
        try {
            Require(OpenProcessToken(GetCurrentProcess(),0xF01FF,out token));
            Require(ConvertStringSidToSidW("S-1-5-32-544",out admin));
            Require(CreateRestrictedToken(token,1,1,new[]{new SidAttributes{Sid=admin}},0,IntPtr.Zero,0,IntPtr.Zero,out restricted));
            Require(ConvertStringSidToSidW("S-1-16-8192",out medium));
            var label=new SidAttributes{Sid=medium,Attributes=0x20};
            Require(SetTokenInformation(restricted,25,ref label,(uint)Marshal.SizeOf(typeof(SidAttributes))+GetLengthSid(medium)));
            string sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
            uint descriptorLength;
            Require(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;"+sid+")(A;;GA;;;SY)S:(ML;;NW;;;ME)",1,out descriptor,out descriptorLength));
            bool present,defaulted;IntPtr acl;
            Require(GetSecurityDescriptorDacl(descriptor,out present,out acl,out defaulted));
            Require(SetTokenInformation(restricted,6,ref acl,(uint)IntPtr.Size));
            var security=new Security{cb=Marshal.SizeOf(typeof(Security)),descriptor=descriptor};
            string stationName="PDFVerify"+Guid.NewGuid().ToString("N");
            station=CreateWindowStationW(stationName,0,0xF037F,ref security);Require(station!=IntPtr.Zero);
            IntPtr original=GetProcessWindowStation();
            Require(SetProcessWindowStation(station));
            try { desktop=CreateDesktopW("Default",null,IntPtr.Zero,0,0xF01FF,ref security);Require(desktop!=IntPtr.Zero); }
            finally { Require(SetProcessWindowStation(original)); }
            var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),flags=1,show=0,desktop=stationName+"\\Default"};
            ProcessInfo process;
            string app=Environment.GetFolderPath(Environment.SpecialFolder.System)+@"\WindowsPowerShell\v1.0\powershell.exe";
            var command=new StringBuilder("\""+app+"\" -NoProfile -ExecutionPolicy Bypass -File \""+script+"\""+(leaveInstalled?" -LeaveInstalled":""));
            Require(CreateProcessAsUserW(restricted,app,command,IntPtr.Zero,IntPtr.Zero,false,0x08000400,IntPtr.Zero,directory,ref startup,out process));
            CloseHandle(process.thread);
            WaitForSingleObject(process.process,0xFFFFFFFF);
            uint code;GetExitCodeProcess(process.process,out code);
            CloseHandle(process.process);
            if(code!=0)throw new Exception("Verification failed: 0x"+code.ToString("X8"));
            return process.pid;
        } finally {
            if(token!=IntPtr.Zero)CloseHandle(token);
            if(restricted!=IntPtr.Zero)CloseHandle(restricted);
            if(admin!=IntPtr.Zero)LocalFree(admin);
            if(medium!=IntPtr.Zero)LocalFree(medium);
            if(desktop!=IntPtr.Zero)CloseDesktop(desktop);
            if(station!=IntPtr.Zero)CloseWindowStation(station);
            if(descriptor!=IntPtr.Zero)LocalFree(descriptor);
        }
    }
}
'@
$root = Split-Path -Parent $PSScriptRoot
[PDFStandardUser]::Run("$PSScriptRoot\Verify.ps1", $root, [bool]$LeaveInstalled)
