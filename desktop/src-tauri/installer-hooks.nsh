; 给随包 Chromium 目录补齐沙箱需要的读取执行权限。
;
; 为什么必须有这一步：Chromium 的子进程跑在沙箱里，其中网络服务用的是 LPAC
; （Less Privileged App Container）。沙箱在拉起子进程前会检查「这个受限令牌读得到
; chrome.exe 吗」，读不到就直接拒绝，报
;
;   Sandbox cannot access executable ...\chromium\chrome.exe. 拒绝访问 (0x5)
;   Network service crashed or was terminated
;
; 网络服务起不来 = 任何导航都提交不了，窗口停在 about:blank：既没有标题也没有
; 地址，用户看到的就是「长时间白屏，然后一个空窗口」。浏览器进程本身活着，所以
; 应用这边看不出任何异常，日志里也没有报错——这个故障模式没有自证能力，只能靠
; 装对权限来预防。
;
; C:\Program Files 的默认 ACL 本来就带这几个 SID（系统装的 Edge 因此正常），
; 而用户自选的目录（D:\Vestus 这种建在盘根下的）继承不到，于是只有随包 Chromium
; 挂掉。安装到哪儿都要能用，所以在这里显式补齐，而不是靠「请装到 Program Files」。
;
; 三个 SID 全部用数字写法，不写名字：ACL 里的名字随系统显示语言变
; （"ALL APPLICATION PACKAGES" / "所有应用程序包"），中文 Windows 上按名字授权会失败。
;
;   S-1-15-2-1  ALL APPLICATION PACKAGES —— 普通 AppContainer 令牌带这个
;   S-1-15-2-2  ALL RESTRICTED APPLICATION PACKAGES —— LPAC 令牌带这个，
;               不带 S-1-15-2-1，所以两个都得给
;   S-1-5-12    RESTRICTED —— 渲染器受限令牌的 restricting SID
;
; 只给 RX（读取+执行），不给写权限：沙箱进程需要读自己的程序文件，不需要改它。
; 这不降低隔离强度——被沙箱限制的是能碰哪些资源，而不是能不能读自己的 exe。

; 只用原生 NSIS 指令（IfFileExists / StrCmp / Goto），不用 LogicLib 的
; ${If}：hook 被 include 的位置由 Tauri 的模板决定，这里不假定 LogicLib 已经
; include 过。赌错了是 NSIS 编译失败，而那要到 Windows 打包时才暴露。
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\chromium\*.*" 0 vestus_acl_done
    DetailPrint "正在为随包 Chromium 配置沙箱访问权限..."
    ; (OI)(CI) 让新建文件继承，/T 覆盖已经铺好的文件，/C 遇到个别文件失败也继续。
    nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$INSTDIR\chromium" /grant "*S-1-15-2-1:(OI)(CI)RX" "*S-1-15-2-2:(OI)(CI)RX" "*S-1-5-12:(OI)(CI)RX" /T /C'
    Pop $0
    Pop $1
    StrCmp $0 "0" vestus_acl_ok vestus_acl_failed

  vestus_acl_ok:
    DetailPrint "Chromium 沙箱权限配置完成。"
    Goto vestus_acl_done

  vestus_acl_failed:
    ; 不中断安装：装完仍然可用于登录和配置，只是打开平台会白屏。把 icacls 的
    ; 原文留在安装日志里，现场排查时不用再猜。
    DetailPrint "警告：Chromium 沙箱权限配置失败（icacls 退出码 $0）。"
    DetailPrint "icacls 输出：$1"
    DetailPrint "若打开平台后停在空白页，请以管理员身份运行以下命令后重试："
    DetailPrint 'icacls "$INSTDIR\chromium" /grant "*S-1-15-2-2:(OI)(CI)RX" /T /C'

  vestus_acl_done:
!macroend
