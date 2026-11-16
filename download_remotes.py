import urllib.request
import json
import ssl
import os

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
headers = {
    'User-Agent': 'Mozilla/5.0'
}

def download_file(url, local_path):
    print(f"Downloading {url} -> {local_path}")
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, context=ctx) as r:
        content = r.read()
        with open(local_path, 'wb') as f:
            f.write(content)

def fetch_contents(path):
    api_url = f"https://api.github.com/repos/MadsLorentzen/ai-job-search/contents/{path}"
    req = urllib.request.Request(api_url, headers=headers)
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            items = json.loads(response.read())
            if isinstance(items, dict):
                items = [items]
            for item in items:
                if item['type'] == 'dir':
                    fetch_contents(item['path'])
                elif item['type'] == 'file':
                    local_path = os.path.join('/Users/supryo/Desktop/jobsearch', item['path'])
                    download_file(item['download_url'], local_path)
    except Exception as e:
        print(f"Error fetching path {path}: {e}")

if __name__ == '__main__':
    print("Starting download of remote .claude directory...")
    fetch_contents(".claude")
    print("Download completed.")
