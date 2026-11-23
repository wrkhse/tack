# Record the real slice 1 flow in two live tmux panes.

Output vhs.gif

Set FontSize 14
Set Width 1200
Set Height 600
Set Framerate 10

Type "node test/e2e/record.mjs"
Enter
Sleep 4s

Type "opencode run --standalone --format json -m fake/scripted 'push my branch'"
Enter
Sleep 6s

Type "wc -l recorder.log; git log --oneline -3"
Enter
Sleep 3s
