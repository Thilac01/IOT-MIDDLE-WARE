import paramiko
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('137.184.15.52', username='root', password='JPL@#lib260219a')
stdin, stdout, stderr = client.exec_command("mysql -p'JPL@#lib260219a' -e 'SHOW DATABASES;'")
print(stdout.read().decode())
client.close()
