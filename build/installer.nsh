; /**
;  * @brief 在 NSIS 删除安装目录前清理当前用户的 Electron 登录项。
;  */
!macro customUnInstall
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --clear-autostart'
!macroend
