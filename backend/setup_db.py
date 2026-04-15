import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('137.184.15.52', username='root', password='JPL@#lib260219a')
client.exec_command('mysql -u root -pJPL@#lib260219a -e "CREATE DATABASE IF NOT EXISTS jpl_security_monitor;"')
client.close()
