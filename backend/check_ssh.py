import paramiko

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    print("Connecting...")
    client.connect('137.184.15.52', username='root', password='JPL@#lib260219a', timeout=10)
    print("Connected! Checking DB...")
    stdin, stdout, stderr = client.exec_command('mysql -u root -pJPL@#lib260219a -e "SELECT user, host FROM mysql.user;"')
    print('STDOUT:', stdout.read().decode())
    print('STDERR:', stderr.read().decode())
except Exception as e:
    print('ERROR:', e)
finally:
    client.close()
